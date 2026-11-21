/**
 * A worker that outlives its own ceiling stops holding the lane.
 *
 * Before this, `runJob` awaited every executor with no bound: a promise that never settled kept its
 * lane for ever, the row said `running`, later work waited behind it, and nothing short of a restart
 * could reclaim it (Developer #1, 2026-11-20). Pinned here: the ceiling belongs to the job type's own
 * work class (two types do not share a timer), the row ends retryable with a sentence naming the type
 * and the bound, the lane carries the next queued job, the row's recorded children are stopped, and a
 * late settlement is logged beside the verdict instead of rewriting it.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { closeLogStream, flushLogLines } from '../services/logger.js'
import {
  JOB_LEASE_CLASS_HOURS,
  JobLeaseExpiredError,
  _setJobLeaseForTesting,
  executionCeilingMs,
  jobLeaseClass,
  withJobLease,
} from '../services/job-lease.js'

let tempDir: string
let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  jq = await import('../services/job-queue.js')
})

after(async () => {
  _setJobLeaseForTesting(null)
  await jq._waitForJobPersistenceForTesting()
  closeLogStream()
  await cleanup()
})

async function logText(): Promise<string> {
  await flushLogLines()
  const file = path.join(tempDir, 'logs', `server-${new Date().toISOString().slice(0, 10)}.log`)
  return fs.readFile(file, 'utf8').catch(() => '')
}

describe('the ceiling belongs to the work, not the process', () => {
  test('each job type is bounded by its own work class', () => {
    _setJobLeaseForTesting(null)
    // A writing job and a local merge are hours apart by design; one global number would cut both.
    assert.ok(executionCeilingMs('outline_only')! > executionCeilingMs('audio_merge')!)
    assert.equal(jobLeaseClass('outline_only'), 'chat')
    assert.equal(jobLeaseClass('audio_merge'), 'local')
    assert.equal(jobLeaseClass('continuity_render'), 'render')
    assert.equal(executionCeilingMs('continuity_render'), JOB_LEASE_CLASS_HOURS.render * 3_600_000)
  })

  test('the bound is a default that can be raised or switched off', () => {
    _setJobLeaseForTesting({ scale: 2 })
    assert.equal(executionCeilingMs('audio_merge'), JOB_LEASE_CLASS_HOURS.local * 2 * 3_600_000)
    _setJobLeaseForTesting({ scale: 0 })
    assert.equal(executionCeilingMs('audio_merge'), null)
    _setJobLeaseForTesting(null)
  })
})

describe('one worker past its ceiling', () => {
  test('is released at its own ceiling while a longer type is still waiting', async () => {
    _setJobLeaseForTesting({ ceilings: { audio_merge: 40, continuity_render: 10_000 } })
    const short = withJobLease({ job_id: 'short', type: 'audio_merge' }, () => new Promise<never>(() => {}))
    let longSettled = false
    const long = withJobLease({ job_id: 'long', type: 'continuity_render' }, async () => {
      longSettled = true
      return 'done'
    })
    await assert.rejects(short, (error: unknown) => {
      assert.ok(error instanceof JobLeaseExpiredError)
      assert.equal(error.ceilingMs, 40)
      assert.match(error.message, /audio_merge/)
      assert.match(error.message, /its own ceiling/)
      assert.match(error.message, /Press Retry/)
      return true
    })
    // The render had its own, much longer ceiling: the merge's expiry never touched it.
    assert.equal(await long, 'done')
    assert.equal(longSettled, true)
    _setJobLeaseForTesting(null)
  })

  test('stops the row\'s recorded children before the row is told', async () => {
    _setJobLeaseForTesting({ ceilings: { audio_merge: 30 } })
    const order: string[] = []
    await assert.rejects(withJobLease(
      { job_id: 'children', type: 'audio_merge' },
      () => new Promise<never>(() => {}),
      { onExpired: () => order.push('children stopped') },
    ))
    order.push('row settled')
    assert.deepEqual(order, ['children stopped', 'row settled'])
    _setJobLeaseForTesting(null)
  })

  test('a late settlement is logged beside the verdict, never returned', async () => {
    _setJobLeaseForTesting({ ceilings: { audio_merge: 30 } })
    let release: (value: string) => void = () => {}
    await assert.rejects(withJobLease(
      { job_id: 'late-settle', type: 'audio_merge' },
      () => new Promise<string>(resolve => { release = resolve }),
    ), JobLeaseExpiredError)
    release('a result that arrived too late')
    await waitFor(async () => (await logText()).includes('settled after its ceiling was crossed'), {
      label: 'the late settlement is named in the log', timeoutMs: 2_000,
    })
    assert.match(await logText(), /late-settle/)
    _setJobLeaseForTesting(null)
  })

  test('releases the lane: the row ends retryable with the sentence and the next queued job starts', async () => {
    let calls = 0
    let stuckChild: ChildProcess | null = null
    jq.registerExecutor('broll_assemble', async () => {
      calls += 1
      // The first run never settles — the shape Production reported — and it leaves a real child
      // behind, which is what an abandoned FFmpeg looks like. The retry resolves.
      if (calls === 1) {
        stuckChild = spawn('sleep', ['60'], { stdio: 'ignore' })
        jq.trackChild(stuckChild)
        await new Promise<never>(() => {})
      }
    })
    _setJobLeaseForTesting({ ceilings: { broll_assemble: 60 } })
    const project = await (await import('../services/project-manager.js'))
      .createProject({ name: 'Job lease lane' })
    await jq.setQueuePaused(false)
    const stuck = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'broll_assemble', episode_id: 'LEASE-1',
      title: 'the worker that never settles', params: {},
    })
    const nextUp = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'broll_assemble', episode_id: 'LEASE-2',
      title: 'the work waiting behind it', params: {},
    })

    await waitFor(() => jq.getJob(stuck.job_id)?.status === 'error', {
      label: 'the stuck row is released at its own ceiling', timeoutMs: 5_000,
    })
    const row = jq.getJob(stuck.job_id)!
    assert.equal(row.job_id, stuck.job_id, 'the row keeps its id, so Retry and the next start can follow it')
    assert.match(String(row.error), /broll_assemble/)
    assert.match(String(row.error), /its own ceiling/)
    assert.ok(row.output_lines.some(line => line.includes('its own ceiling')))

    // The abandoned worker's own child was stopped with it, not left writing into the temp dir.
    await waitFor(() => Boolean(stuckChild && (stuckChild.killed || stuckChild.exitCode !== null)), {
      label: 'the row\'s recorded child was stopped at its ceiling', timeoutMs: 5_000,
    })
    await waitFor(() => jq.getJob(nextUp.job_id)?.status === 'done', {
      label: 'the freed lane carried the next queued job', timeoutMs: 5_000,
    })
    assert.equal(calls, 2)
    _setJobLeaseForTesting(null)
  })
})
