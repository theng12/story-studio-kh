/**
 * Owner, 2026-10-09: "Start next episode early." Story narrates N episodes at a
 * time; each pair's tail left the fleet idle (median 5.5 min, max 48 min) while
 * 11 narration jobs sat queued for hours. Once a running episode is down to its
 * last NARRATION_TAIL_PARTS parts, ONE more queued episode starts beside it.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => {
  jq.setAudioEpisodeConcurrency(1)
  await cleanup()
})

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}
const settle = () => new Promise(r => setTimeout(r, 40))

test('the next narration episode starts at the tail, never past the owner number + 1, in order, pauses respected', async () => {
  const proj = await pm.createProject({ name: 'NARR-TAIL' })
  const running = new Map<string, Job>()
  const releases = new Map<string, () => void>()
  const started: string[] = []
  let peak = 0
  jq.registerExecutor('audio', async (job: Job) => {
    running.set(job.episode_id, job)
    started.push(job.episode_id)
    peak = Math.max(peak, running.size)
    await new Promise<void>(resolve => releases.set(job.episode_id, resolve))
    running.delete(job.episode_id)
  })
  const progress = (ep: string, total: number, completed: number) => {
    running.get(ep)!.item_progress = { total, completed, failed: 0, concurrency: 8, active: [] }
    jq.noteNarrationProgress()
  }
  const finish = async (ep: string) => { releases.get(ep)!(); await waitFor(() => !running.has(ep)) }

  jq.setAudioEpisodeConcurrency(2)
  const queued: Job[] = []
  for (const ep of ['EP001', 'EP002', 'EP003', 'EP004', 'EP005', 'EP006']) {
    queued.push(jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'audio', episode_id: ep, title: ep, params: {} }) as Job)
  }
  // The owner pauses EP004 by hand: the tail must never start it.
  await waitFor(() => running.size === 2)
  await jq.pauseJob(queued[3]!.job_id)

  progress('EP001', 100, 79) // 21 parts left: not a tail yet
  await settle()
  assert.deepEqual(started, ['EP001', 'EP002'], 'two full episodes, no early start above the threshold')

  progress('EP001', 100, 80) // 20 left: the tail
  await waitFor(() => running.size === 3)
  assert.deepEqual(started, ['EP001', 'EP002', 'EP003'], 'the next queued episode starts early, in queue order')

  progress('EP002', 100, 95) // a second tail never opens a fourth slot
  await settle()
  assert.equal(running.size, 3, 'never more than 2 full + 1 tail overlap')

  // EP001 finishes; EP002 is still in its tail, so the lane refills to 3 — skipping paused EP004.
  await finish('EP001')
  await waitFor(() => running.size === 3)
  assert.deepEqual(started, ['EP001', 'EP002', 'EP003', 'EP005'], 'paused EP004 is skipped; order kept')

  // A tail job the owner is pausing does not count as a tail.
  running.get('EP002')!.pause_requested = true
  await finish('EP003')
  await settle()
  assert.equal(running.size, 2, 'no early start while the only tail is being paused')
  running.get('EP002')!.pause_requested = false

  await finish('EP002')
  await finish('EP005')
  await waitFor(() => running.has('EP006'))
  await finish('EP006')
  await settle()
  assert.equal(peak, 3)
  assert.ok(!started.includes('EP004'), 'the paused episode never ran')
})

test('with the global queue paused nothing starts early', async () => {
  const proj = await pm.createProject({ name: 'NARR-TAIL-PAUSED' })
  const running = new Map<string, Job>()
  const releases: Array<() => void> = []
  jq.registerExecutor('audio', async (job: Job) => {
    running.set(job.episode_id, job)
    await new Promise<void>(resolve => releases.push(resolve))
    running.delete(job.episode_id)
  })
  jq.setAudioEpisodeConcurrency(1)
  for (const ep of ['EP001', 'EP002']) {
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'audio', episode_id: ep, title: ep, params: {} })
  }
  await waitFor(() => running.size === 1)
  await jq.setQueuePaused(true)
  running.get('EP001')!.item_progress = { total: 10, completed: 9, failed: 0, concurrency: 4, active: [] }
  jq.noteNarrationProgress()
  await settle()
  assert.equal(running.size, 1, 'the pause wins over the tail')
  await jq.setQueuePaused(false)
  releases.splice(0).forEach(release => release())
  await waitFor(() => running.has('EP002'))
  releases.splice(0).forEach(release => release())
  await waitFor(() => running.size === 0)
})
