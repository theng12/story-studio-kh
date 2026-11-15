/**
 * A Story retry or replacement RETIRES the original job instead of erasing it
 * (owner, 2026-11-15: "nothing deleted for good").
 *
 * Four proofs:
 *   1. the original stays present and terminal with its evidence intact and a
 *      `superseded: { at, by, reason, superseded_by }` marker;
 *   2. the new row points back through `previous_job_id`;
 *   3. the active list and its "needs attention" counts exclude it;
 *   4. history still reads the row — with the old→new link — and the facets
 *      count it only as `superseded`, never in a status chip or bulk count.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

void test('a retry retires the original job with its evidence intact and an old-new link', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Retry Supersede' })
  try {
    jq.registerExecutor('research_run', async () => { throw new Error('first attempt failed') })
    const original = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'research_run',
      episode_id: 'EP001',
      title: 'Superseded research',
      params: { model: 'cloud-model', auto_retry: false },
    })
    await waitFor(
      () => jq.getJob(original.job_id)?.status === 'error'
        && !jq._isJobWorkerActiveForTesting(original.job_id),
      { label: 'original fails and its worker settles', timeoutMs: 4_000 },
    )
    const before = jq.getJob(original.job_id)!

    jq.registerExecutor('research_run', async () => {})
    const retried = jq.retryTerminalJob(project.slug, original.job_id)
    await jq._waitForJobPersistenceForTesting()

    // 1. Retire, not erase: present, terminal, marked, evidence untouched.
    const retained = jq.getJob(original.job_id)
    assert.ok(retained, 'the original row is still present')
    assert.equal(retained.status, 'error')
    assert.equal(retained.error, before.error)
    assert.deepEqual(retained.params, before.params)
    assert.deepEqual(retained.output_lines, before.output_lines)
    assert.equal(retained.finished_at, before.finished_at)
    assert.ok(retained.superseded, 'the original carries the superseded marker')
    assert.equal(retained.superseded.by, 'Story Studio')
    assert.equal(retained.superseded.superseded_by, retried.job_id)

    // 2. The replacement points back.
    assert.equal(retried.previous_job_id, original.job_id)
    assert.equal(jq.getJob(retried.job_id)?.previous_job_id, original.job_id)

    // 3. Off the active list: no badge counts it.
    assert.equal(jq.getQueueStats(project.slug).error, 0, 'the superseded failure is not in "Needs attention"')
    assert.equal((await jq.countJobs(project.slug)).error, 0, 'nor in the channel counts')

    // 4. History keeps the row with its link, and counts it only as superseded.
    const page = await jq.queryJobHistory([project.slug], {}, { all: true, facets: true })
    const row = page.jobs.find(job => job.job_id === original.job_id)
    assert.ok(row, 'the retired row is still readable from history')
    assert.equal(row.superseded?.superseded_by, retried.job_id, 'the row carries the old→new link')
    assert.equal(page.facets?.superseded, 1)
    assert.equal(page.facets?.stats.error, 0, 'nor in the header error count')
    assert.equal(page.facets?.status.error ?? 0, 0, 'nor in the status chips')
    assert.equal(page.facets?.clearable.failed, 0, 'nor in the bulk clear count')
    assert.equal(page.facets?.hidden, 0, 'a real zero: it is superseded, not hidden')
  } finally {
    await jq._waitForJobPersistenceForTesting().catch(() => {})
    await temp.cleanup()
  }
})
