/**
 * Update hold — the contract the Studio Launcher calls before it replaces the
 * app (contract: `_orchestra/youtube-stack/update-hold/CONTRACT.md`; shape
 * copied from Gateway's `/api/maintenance/drain`).
 *
 *   POST   /api/maintenance/hold  ?timeout_s=20&pause_s=120
 *   DELETE /api/maintenance/hold
 *
 * The proof the contract owes, with LIVE work queued rather than an idle queue:
 *   1. POST closes the claim/dispatch path — no new job is claimed by any
 *      lane — and the reply's `in_flight` matches reality.
 *   2. In-flight work at the deadline either settles or keeps a resumable id;
 *      asserted on the durable row and the would-not-resume flag, not the log.
 *   3. A restart with no DELETE dispatches again with no manual step: the hold
 *      writes nothing durable, so a fresh reader sees an unpaused queue.
 *   4. Hold, then no restart: dispatch resumes by itself after `pause_s`.
 *
 * The two 300 ms negative observation windows are explicitly counted in `_timing-baseline.json`:
 * they prove nothing starts or replies during the hold, rather than waiting for work to finish.
 * See `_timing.ts`: replacing a negative observation window with polling would lose that proof.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor, sleep } from './_timing.js'

let tempDir: string
let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let app: express.Express

// chapter-only owns a single-slot lane: one job occupies it, the next waits
// behind it in pending — the "live work queued" fixture.
let chapterRuns = 0
let chapterFree = false
const chapterGates: Array<() => void> = []
// metadata rides the free LLM lane — the "any lane" claim probe.
let metadataRuns = 0
// thumb_images has no boot recovery kind: a running one is exactly what a
// restart would NOT continue where it stopped, i.e. the unsettled case.
let thumbRuns = 0
let thumbFree = false
const thumbGates: Array<() => void> = []

function nextGate(gates: Array<() => void>): Promise<void> {
  return new Promise(resolve => { gates.push(resolve) })
}
function releaseGates(gates: Array<() => void>): void {
  for (const resolve of gates.splice(0)) resolve()
}

function enqueue(projectSlug: string, type: 'chapter-only' | 'metadata' | 'thumb_images', episodeId: string, title: string) {
  return jq.enqueuePreparedForTest({ project_slug: projectSlug, type, episode_id: episodeId, title, params: {} })
}

before(async () => {
  const isolated = await useTempDataDir()
  tempDir = isolated.dir
  cleanup = isolated.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  const { router } = await import('../routes/system.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)

  jq.registerExecutor('chapter-only', async () => {
    chapterRuns += 1
    if (!chapterFree) await nextGate(chapterGates)
  })
  jq.registerExecutor('metadata', async () => { metadataRuns += 1 })
  jq.registerExecutor('thumb_images', async () => {
    thumbRuns += 1
    if (!thumbFree) await nextGate(thumbGates)
  })
})

after(async () => {
  jq._clearUpdateHoldForTesting()
  chapterFree = true
  thumbFree = true
  releaseGates(chapterGates)
  releaseGates(thumbGates)
  await jq.setQueuePaused(false).catch(() => {})
  await cleanup()
})

// Health is the only place a hold is visible: it writes nothing durable, so a person or an agent
// looking for "why is nothing starting" must be able to see it, and its expiry is what makes a lost
// DELETE harmless (the installer's resume is best effort, and a killed installer sends nothing).
test('health names a hold in force, and the hold clears itself without a boot', async () => {
  const { updateHoldState } = await import('../services/job-queue.js')
  assert.deepEqual(await updateHoldState(), { active: false, owner: 'updater', expires_at: null })
  await request(app).post('/api/maintenance/hold?timeout_s=0&pause_s=1').expect(200)
  const during = await updateHoldState()
  assert.equal(during.active, true, 'a hold in force is visible on health')
  assert.equal(during.owner, 'updater')
  assert.ok(Date.parse(during.expires_at!) > Date.now(), 'and says when it expires')
  // Poll for the expiry rather than betting 1200 ms covers a 1 s hold: this is "has happened",
  // which load can only delay, never fake.
  await waitFor(async () => (await updateHoldState()).active === false, { label: 'the hold to expire by itself' })
  const after1 = await updateHoldState()
  assert.equal(after1.active, false, 'it expires by itself — no DELETE, no restart')
  assert.equal(after1.expires_at, null)
})

describe('POST/DELETE /api/maintenance/hold', () => {
  test('the hold closes every claim path and in_flight matches the live worker', async () => {
    const project = await pm.createProject({ name: 'Update Hold Live Work' })
    const running = enqueue(project.slug, 'chapter-only', 'UH001', 'in flight')
    await waitFor(() => chapterRuns === 1 && jq.getJob(running.job_id)?.status === 'running', {
      label: 'first chapter job to occupy its lane',
    })

    // Live work queued: behind the running job in the same single-slot lane.
    const queuedSameLane = enqueue(project.slug, 'chapter-only', 'UH002', 'queued behind the live job')
    assert.equal(jq.getJob(queuedSameLane.job_id)?.status, 'queued')

    const held = await request(app).post('/api/maintenance/hold?timeout_s=0&pause_s=60').expect(200)
    assert.deepEqual(Object.keys(held.body).sort(), ['dispatch_paused_s', 'in_flight', 'safe', 'unsettled'])
    assert.equal(held.body.in_flight, 1, 'in_flight is the one live worker')
    assert.equal(held.body.dispatch_paused_s, 60)

    // Free the running job's lane WHILE the hold owns dispatch: releaseSlot
    // pumps, and the hold must refuse the claim that pump would otherwise make.
    chapterFree = true
    releaseGates(chapterGates)
    await waitFor(() => jq.getJob(running.job_id)?.status === 'done', { label: 'the live job to settle' })

    // A different, completely free lane — nothing new may be claimed anywhere.
    const queuedOtherLane = enqueue(project.slug, 'metadata', 'UH003', 'queued on a free lane')
    await sleep(300) // observation window: the hold must keep both rows queued
    assert.equal(chapterRuns, 1, 'the freed lane claimed no second chapter job')
    assert.equal(metadataRuns, 0, 'the free lane claimed no metadata job')
    assert.equal(jq.getJob(queuedSameLane.job_id)?.status, 'queued')
    assert.equal(jq.getJob(queuedOtherLane.job_id)?.status, 'queued')

    const resumed = await request(app).delete('/api/maintenance/hold').expect(200)
    assert.equal(resumed.body.dispatch_paused_s, 0, 'DELETE resumes at once')
    await waitFor(() => jq.getJob(queuedSameLane.job_id)?.status === 'done', { label: 'the held lane to resume' })
    await waitFor(() => jq.getJob(queuedOtherLane.job_id)?.status === 'done', { label: 'the other lane to resume' })
    assert.equal(chapterRuns, 2)
    assert.equal(metadataRuns, 1)
  })

  test('in-flight work at the deadline keeps its resumable id, and settles when it can', async () => {
    const project = await pm.createProject({ name: 'Update Hold Deadline' })
    const running = enqueue(project.slug, 'thumb_images', 'UH010', 'no boot recovery kind')
    await waitFor(() => thumbRuns === 1 && jq.getJob(running.job_id)?.status === 'running', {
      label: 'the thumb job to go in flight',
    })

    // The deadline passes with the job still running: a restart would not
    // continue it where it stopped, so it is unsettled — and the row the next
    // start reads must be there, never an unknown outcome.
    const atDeadline = await request(app).post('/api/maintenance/hold?timeout_s=0&pause_s=60').expect(200)
    assert.equal(atDeadline.body.safe, false, 'a restart now would strand the in-flight job')
    assert.deepEqual(atDeadline.body.unsettled, [running.job_id])
    assert.equal(atDeadline.body.in_flight, 1)
    assert.ok(
      (await jq.runningJobsThatWouldNotResume()).some(job => job.job_id === running.job_id),
      'flag: the hold named the job a restart would not continue',
    )
    await jq._waitForJobPersistenceForTesting()
    const onDisk = JSON.parse(await fs.readFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), 'utf8'))
    const row = onDisk.jobs.find((job: { job_id: string }) => job.job_id === running.job_id)
    assert.ok(row, 'the id survives on disk for the next start')
    assert.equal(row.status, 'running', 'a row the next start follows (requeue, reconcile, or interrupted+retry)')

    // The other half: the same hold answers safe once the work settles inside
    // its window — the drain waits for the still-in-flight job instead of
    // giving up at once. The request must be on the wire BEFORE the release,
    // or its first poll would only ever see the finished job.
    await request(app).delete('/api/maintenance/hold').expect(200)
    let answerBody: Record<string, unknown> | null = null
    const settling = request(app)
      .post('/api/maintenance/hold?timeout_s=10&pause_s=60')
      .then(res => { answerBody = res.body; return res })
    await sleep(300) // the settle window is open while the job is still blocked
    assert.equal(answerBody, null, 'the hold waits for the in-flight job instead of replying at once')
    thumbFree = true
    releaseGates(thumbGates)
    const settled = await settling
    assert.equal(settled.status, 200)
    assert.equal(settled.body.safe, true, 'the settle window waited for the job')
    assert.deepEqual(settled.body.unsettled, [])
    assert.equal(jq.getJob(running.job_id)?.status, 'done')
    await request(app).delete('/api/maintenance/hold').expect(200)
  })

  // The hold's own question is "would a restart continue this job?", not "is the local executor
  // still busy". A row every provider already gave a final answer to cannot settle by being
  // waited on, so naming it keeps the install unsafe for ever (2026-11-18: twelve rows terminal
  // 17–35 h were still counted, so `safe` could only become true after a person cleaned rows).
  test('a row whose provider work is already over does not hold the install back', async () => {
    const project = await pm.createProject({ name: 'Update Hold Terminal Evidence' })
    thumbFree = false
    const running = enqueue(project.slug, 'thumb_images', 'UH040', 'provider answer already final')
    await waitFor(() => jq.getJob(running.job_id)?.status === 'running', { label: 'the thumb job to go in flight' })
    await jq.recordGenStudioJob(running.job_id, { id: 'gw-uh040', operation: 'image.generation', state: 'failed', updated_at: new Date().toISOString() })

    // A full window on purpose: with nothing left that could settle, the answer must not wait it out.
    const startedAt = Date.now()
    const held = await request(app).post('/api/maintenance/hold?timeout_s=20&pause_s=60').expect(200)
    assert.ok(Date.now() - startedAt < 1_000, `answered at once, not at the deadline (${Date.now() - startedAt} ms)`)
    assert.equal(held.body.in_flight, 1, 'the row is still in flight locally')
    assert.deepEqual(held.body.unsettled, [], 'a final provider answer is not something to wait for')
    assert.equal(held.body.safe, true)
    assert.ok(
      !(await jq.runningJobsThatWouldNotResume()).some(job => job.job_id === running.job_id),
      'not flagged as work a restart cannot follow',
    )

    thumbFree = true
    releaseGates(thumbGates)
    await waitFor(() => jq.getJob(running.job_id)?.status === 'done', { label: 'the live job to settle' })
    await request(app).delete('/api/maintenance/hold').expect(200)
  })

  // The other direction, and the reason the exemption is narrow: a live provider answer with no
  // boot branch is exactly what a restart would strand.
  test('a running row with a live Gateway id and no boot branch is still unsettled', async () => {
    const project = await pm.createProject({ name: 'Update Hold Live Provider' })
    thumbFree = false
    const running = enqueue(project.slug, 'thumb_images', 'UH050', 'provider still running')
    await waitFor(() => jq.getJob(running.job_id)?.status === 'running', { label: 'the live thumb job to go in flight' })
    await jq.recordGenStudioJob(running.job_id, { id: 'gw-uh050', operation: 'image.generation', state: 'running', updated_at: new Date().toISOString() })

    const held = await request(app).post('/api/maintenance/hold?timeout_s=0&pause_s=60').expect(200)
    assert.equal(held.body.safe, false)
    assert.deepEqual(held.body.unsettled, [running.job_id])

    thumbFree = true
    releaseGates(thumbGates)
    await waitFor(() => jq.getJob(running.job_id)?.status === 'done', { label: 'the live job to settle' })
    await request(app).delete('/api/maintenance/hold').expect(200)
  })

  // A hold the Gateway cannot close and only a person can: still unsettled, but waiting changes
  // nothing, so the names come back at once instead of at the deadline.
  test('a row that provably cannot settle answers at once instead of waiting out the window', async () => {
    const project = await pm.createProject({ name: 'Update Hold Nothing Settles' })
    thumbFree = false
    const running = enqueue(project.slug, 'thumb_images', 'UH060', 'a hold only a person can close')
    await waitFor(() => jq.getJob(running.job_id)?.status === 'running', { label: 'the thumb job to go in flight' })
    await jq.recordGenStudioJob(running.job_id, {
      id: 'gw-uh060', operation: 'music.generation', state: 'failed',
      recovery_required: true, recovery_state: 'unknown_outcome', updated_at: new Date().toISOString(),
    })

    const startedAt = Date.now()
    const held = await request(app).post('/api/maintenance/hold?timeout_s=20&pause_s=60').expect(200)
    const elapsed = Date.now() - startedAt
    assert.equal(held.body.safe, false)
    assert.deepEqual(held.body.unsettled, [running.job_id])
    assert.ok(elapsed < 1_000, `answered at once with the name, not at the deadline (${elapsed} ms)`)

    thumbFree = true
    releaseGates(thumbGates)
    await waitFor(() => jq.getJob(running.job_id)?.status === 'done', { label: 'the live job to settle' })
    await request(app).delete('/api/maintenance/hold').expect(200)
  })

  test('one row that can still settle keeps the whole window', async () => {
    const project = await pm.createProject({ name: 'Update Hold Still Settling' })
    thumbFree = false
    const running = enqueue(project.slug, 'thumb_images', 'UH070', 'provider can still answer')
    await waitFor(() => jq.getJob(running.job_id)?.status === 'running', { label: 'the thumb job to go in flight' })
    await jq.recordGenStudioJob(running.job_id, { id: 'gw-uh070', operation: 'image.generation', state: 'running', updated_at: new Date().toISOString() })

    const startedAt = Date.now()
    const held = await request(app).post('/api/maintenance/hold?timeout_s=2&pause_s=60').expect(200)
    const elapsed = Date.now() - startedAt
    assert.equal(held.body.safe, false)
    assert.deepEqual(held.body.unsettled, [running.job_id])
    assert.ok(elapsed >= 1_800, `held the answer for the window (${elapsed} ms)`)

    thumbFree = true
    releaseGates(thumbGates)
    await waitFor(() => jq.getJob(running.job_id)?.status === 'done', { label: 'the live job to settle' })
    await request(app).delete('/api/maintenance/hold').expect(200)
  })

  test('a restart with no DELETE dispatches again: the hold writes nothing durable', async () => {
    const { getAllAppSettings } = await import('../services/app-settings.js')
    const held = await request(app).post('/api/maintenance/hold?timeout_s=0&pause_s=60').expect(200)
    assert.equal(held.body.dispatch_paused_s, 60)

    // Nothing a next process could read as a latch: the owner's durable queue
    // pause keys stay exactly as they were.
    const during = await getAllAppSettings()
    assert.notEqual(during['job_queue_paused'], true, 'an update hold never persists a pause')
    assert.equal(during['job_queue_pause_owner'] ?? null, null, 'an update hold never claims durable ownership')

    // A fresh process re-reads that same durable state and starts with no
    // hold at all (the in-memory flag does not exist there) — so dispatch
    // works again with no manual step, even though nothing was ever DELETEd.
    jq._clearUpdateHoldForTesting()
    jq._resetQueuePauseStateForTesting()
    await jq.initializeQueuePauseState()
    assert.equal(jq.isQueuePaused(), false, 'the durable read a restart performs says: dispatch')

    const project = await pm.createProject({ name: 'Update Hold Restart' })
    const runsBefore = metadataRuns
    const job = enqueue(project.slug, 'metadata', 'UH020', 'dispatch after restart')
    await waitFor(() => jq.getJob(job.job_id)?.status === 'done', { label: 'dispatch with no manual step' })
    assert.equal(metadataRuns, runsBefore + 1)
  })

  test('hold, then no restart: dispatch resumes by itself after pause_s', async () => {
    const runsBefore = metadataRuns
    // A long pause for the negative half: a 1s pause expired under load before the 20 event-loop
    // turns below finished, and the claim that arrived then was the product working, not a defect.
    // A pause of 600s cannot expire in those turns on any machine, so this half is load-proof.
    const held = await request(app).post('/api/maintenance/hold?timeout_s=0&pause_s=600').expect(200)
    assert.equal(held.body.dispatch_paused_s, 600)

    const project = await pm.createProject({ name: 'Update Hold Auto Resume' })
    const job = enqueue(project.slug, 'metadata', 'UH030', 'waits out the pause')
    // Event-loop turns, not a wall-clock sleep: the claim that must NOT happen
    // is the one enqueue's own pump would have made right now.
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve))
    assert.equal(metadataRuns, runsBefore, 'no claim while the pause is live')
    assert.equal(jq.getJob(job.job_id)?.status, 'queued')

    // No DELETE, no restart: re-taking the hold with a 1s pause replaces the long one and its
    // kick timer, so the pause expires by itself and the hold's own kick pump admits the row.
    const shortHold = await request(app).post('/api/maintenance/hold?timeout_s=0&pause_s=1').expect(200)
    assert.equal(shortHold.body.dispatch_paused_s, 1)
    await waitFor(() => jq.getJob(job.job_id)?.status === 'done', {
      label: 'auto-resume after pause_s',
      timeoutMs: 8_000,
    })
    assert.equal(metadataRuns, runsBefore + 1)
  })
})
