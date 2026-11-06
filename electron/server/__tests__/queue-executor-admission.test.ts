/**
 * Executor-settlement admission regression.
 *
 * A job's row turns terminal before its worker actually settles: Stop and Force
 * abandon write `cancelled` from another call context, and a finishing executor
 * writes `done`/`error` before runJob's finally releases the slot. During that
 * window `isDuplicate` no longer sees the job (it reads queued/running/paused),
 * and history removal can delete the row outright, so a Retry or a fresh enqueue
 * used to start a second executor for the same project/episode/type beside the
 * first one. Admission now refuses on the live worker records until the worker
 * settles — regardless of dedupeParams, a terminal row, or a deleted row.
 *
 * Every hold is a controlled promise barrier. `entered` is fired inside the mock
 * immediately before the hold, because a `running` status is published before
 * awaited persistence and executor entry, so status alone is not proof the
 * executor is inside. Nothing here sleeps: every wait uses the queue's own
 * active seam or the shared scheduled-time helper, and cleanup opens every
 * barrier, drains every admitted job (including one an unexpectedly successful
 * refusal let through), and only then restores the mock executors.
 */
import { test, describe, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import type { Job, JobType } from '../models/types.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

interface Barrier { promise: Promise<void>; open: () => void }
function barrier(): Barrier {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

/** A one-shot "the mock is inside the executor" signal, observed by waitFor's bounded clock. */
interface Signal { fire: () => void; fired: () => boolean }
function signal(): Signal {
  let fired = false
  return { fire: () => { fired = true }, fired: () => fired }
}

async function awaitEntered(entered: Signal, label: string): Promise<void> {
  if (!entered.fired()) await waitFor(() => entered.fired(), { label })
}

// Every admitted job, every barrier and every mock executor is file-level state:
// a failed assertion must not leave a replacement worker running under the next
// test's executor (or under the restored production one).
const tracked = new Map<string, Job>()
const projects: string[] = []
const gates: Barrier[] = []
const restores: Array<() => void> = []

function fixtureGate(): Barrier {
  const gate = barrier()
  gates.push(gate)
  return gate
}

function useExecutor(type: JobType, executor: (job: Job) => Promise<void>): void {
  restores.push(jq._setExecutorForTesting(type, executor))
}

async function newProject(name: string) {
  const project = await pm.createProject({ name })
  projects.push(project.slug)
  return project
}

function track<T extends Job>(job: T): T {
  tracked.set(job.job_id, job)
  return job
}

/** Track a job returned as a plain row or as `{ job, reused }` by a direct requeue. */
function trackOutcome(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const record = value as { job_id?: unknown; job?: unknown }
  if (typeof record.job_id === 'string') track(record as unknown as Job)
  else if (record.job && typeof (record.job as { job_id?: unknown }).job_id === 'string') {
    track(record.job as Job)
  }
}

function assertDuplicateRefusal(error: unknown, expectedMessage?: string): void {
  assert.ok(error instanceof jq.DuplicateJobError,
    `expected DuplicateJobError, got ${(error as any)?.name}: ${(error as any)?.message}`)
  assert.equal((error as any).status, 409)
  assert.equal((error as any).expose, true)
  if (expectedMessage !== undefined) assert.equal((error as Error).message, expectedMessage)
}

/** The truthful wording for a worker that is still unwinding, not queued/running. */
function settlingMessage(type: JobType, episode: string): string {
  return `The previous ${type} job for ${episode} is still finishing locally. Wait until it finishes, then try again.`
}

/** A refused admission keeps the shared 409 contract of the queue. */
function refusal(run: () => unknown, expectedMessage?: string): void {
  let outcome: { value: unknown } | { error: unknown }
  try { outcome = { value: run() } } catch (error) { outcome = { error } }
  if ('value' in outcome) {
    // Admission unexpectedly succeeded: track the replacement before failing so
    // cleanup waits for it instead of leaving it under the next test's executor.
    trackOutcome(outcome.value)
    assert.fail('expected a 409 refusal while the previous executor is settling; admission unexpectedly succeeded')
  }
  assertDuplicateRefusal(outcome.error, expectedMessage)
}

/** The same 409 contract for an async caller (direct requeue actions). */
async function refusalAsync(run: () => Promise<unknown>, expectedMessage?: string): Promise<void> {
  let outcome: { value: unknown } | { error: unknown }
  try { outcome = { value: await run() } } catch (error) { outcome = { error } }
  if ('value' in outcome) {
    trackOutcome(outcome.value)
    assert.fail('expected a 409 refusal while the previous executor is settling; admission unexpectedly succeeded')
  }
  assertDuplicateRefusal(outcome.error, expectedMessage)
}

/** Open the barrier and wait for runJob's finally, not for a timer. */
async function releaseAndSettle(gate: Barrier, jobId?: string): Promise<void> {
  gate.open()
  if (jobId) await waitFor(() => !jq._isJobWorkerActiveForTesting(jobId), { label: `job ${jobId} to settle` })
}

/** A continuity row whose first executor attempt failed and whose error row is durable. */
async function awaitFailedContinuity(jobId: string): Promise<void> {
  await waitFor(() => jq.getJob(jobId)?.status === 'error'
    && !jq._isJobWorkerActiveForTesting(jobId), { label: `the failed scene render ${jobId} to settle` })
  await jq._waitForJobPersistenceForTesting()
}

/**
 * A fenced Finish row is accepted durably and keeps its place in the lane, but
 * the shared pump has not registered an executor for it. Both the live row and
 * the persisted row are checked, so this cannot pass on a rollback or an orphan.
 */
async function assertFinishDeferred(
  projectSlug: string,
  jobId: string,
  attempts: Map<string, number>,
  expectedAttempts: number,
): Promise<void> {
  assert.equal(jq.getJob(jobId)?.status, 'queued')
  assert.equal(jq._isJobWorkerActiveForTesting(jobId), false, 'the fenced row has no executor')
  assert.equal(attempts.get(jobId) || 0, expectedAttempts, 'no executor entry while the row waits')
  const row = (await jq.getJobs(projectSlug)).find(job => job.job_id === jobId)
  assert.equal(row?.status, 'queued')
  assert.equal(row?.queue_position, 1, 'the blocked row stays at its FIFO position')
  const durable = await jq.loadAuthoritativeJob(projectSlug, jobId)
  assert.equal(durable?.job_id, jobId)
  assert.equal(durable?.status, 'queued', 'the same durable row is queued, not rolled back')
}

afterEach(async () => {
  // A failed pause fixture must not leave intake fenced for the next test.
  if (jq.isQueuePaused()) await jq.setQueuePaused(false)
  for (const gate of gates) gate.open()
  try {
    for (const job of tracked.values()) {
      const id = job.job_id
      await waitFor(() => !jq._isJobWorkerActiveForTesting(id), { label: `tracked job ${id} to settle` })
    }
    // Also catch work the queue itself admitted (a Pipeline hand-off) that the
    // test never held a return value for. Mock executors stay installed until
    // every row in every fixture project is terminal.
    for (const slug of projects) {
      await waitFor(async () => {
        const all = await jq.getJobs(slug)
        return all.every(job => ['done', 'error', 'cancelled'].includes(job.status)
          && !jq._isJobWorkerActiveForTesting(job.job_id))
      }, { label: `every job in ${slug} to settle before its mock executor is removed` })
    }
    await jq._waitForJobPersistenceForTesting()
  } finally {
    while (restores.length) restores.pop()!()
    gates.length = 0
    tracked.clear()
  }
})

describe('queue executor-settlement admission', () => {
  test('Stop: Retry and a fresh enqueue are refused until the stopping worker settles, then admitted', async () => {
    const project = await newProject('Queue Admission Stop')
    const episode = 'EP-STOP'
    const gate = fixtureGate()
    const entered = signal()
    let heldId = ''
    const runs = new Map<string, number>()
    useExecutor('broll_assemble', async job => {
      runs.set(job.job_id, (runs.get(job.job_id) || 0) + 1)
      job.result = { complete: true }
      if (job.job_id === heldId) {
        entered.fire()
        await gate.promise
      }
    })

    let original: Job | undefined
    try {
      original = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'stop target', params: { auto_retry: false },
      }))
      heldId = original.job_id
      await awaitEntered(entered, 'the stop target executor to be held')
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true)

      // The ordinary duplicate path keeps DuplicateJobError's original wording;
      // only a row whose worker already wrote a terminal status gets the
      // truthful "still finishing locally" text.
      refusal(() => jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'ordinary duplicate', params: { auto_retry: false, model: 'another' },
      }), `broll_assemble generation already queued/running for ${episode}`)

      const stopped = await jq.requestJobCancellation(project.slug, heldId)
      assert.equal(stopped.status, 'cancelled')
      assert.equal(jq.getJob(heldId)?.status, 'cancelled')
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true, 'the executor is still held after its row turned terminal')
      const settling = jq.getPublicJob(heldId)!
      assert.equal(settling.control?.label, 'Check again')
      assert.match(settling.control?.reason || '', /Cancellation is saved.*still stopping its local worker/)
      assert.deepEqual(settling.controls?.map(control => control.action), ['recheck-provider-status'])
      for (const view of ['stream', 'row'] as const) {
        const row = (await jq.getJobs(project.slug, { view })).find(job => job.job_id === heldId)
        assert.equal(row?.control?.label, 'Check again', `${view} keeps the same local settling truth`)
      }
      const checked = await jq.recheckJobProviderStatus(project.slug, heldId)
      assert.equal(checked.status, 'cancelled')
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true, 'Check again never releases a live worker')
      assert.equal(runs.size, 1, 'Check again admits no replacement')

      refusal(() => jq.retryTerminalJob(project.slug, heldId), settlingMessage('broll_assemble', episode))
      refusal(() => jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'fresh beside the stop', params: { auto_retry: false, model: 'another' },
      }))
      assert.equal(jq.getJob(heldId)?.status, 'cancelled', 'a refused admission never mutates the settling row')
    } finally {
      await releaseAndSettle(gate, original?.job_id)
    }

    assert.doesNotMatch(jq.getPublicJob(original!.job_id)?.control?.reason || '', /still stopping its local worker/)
    const retried = track(jq.retryTerminalJob(project.slug, original!.job_id))
    assert.notEqual(retried.job_id, original!.job_id)
    await waitFor(() => jq.getJob(retried.job_id)?.status === 'done', { label: 'the admitted retry to finish' })
    assert.equal(runs.get(retried.job_id), 1)
  })

  test('Force abandon: refusal changes neither params nor provider identities, and a fresh Retry is admitted after settlement', async () => {
    const project = await newProject('Queue Admission Abandon')
    const episode = 'EP-ABANDON'
    const gate = fixtureGate()
    const entered = signal()
    let heldId = ''
    const savedParams = {
      auto_retry: false,
      model: 'saved-model',
      operation_id: 'operation-1',
      generation_action: { id: 'action-1', kind: 'fresh' },
    }
    useExecutor('broll_assemble', async job => {
      job.result = { complete: true }
      if (job.job_id === heldId) {
        job.genstudio_jobs = [{
          id: 'provider-image-1',
          operation: 'image.generation',
          state: 'succeeded',
          updated_at: new Date().toISOString(),
          request: {
            method: 'POST',
            path: '/v1/images',
            idempotency_key: 'provider-key-1',
            captured_at: new Date().toISOString(),
          },
        }]
        entered.fire()
        await gate.promise
      }
    })

    let original: Job | undefined
    try {
      original = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'abandon target', params: savedParams,
      }))
      heldId = original.job_id
      await awaitEntered(entered, 'the abandon target executor to be held')

      const abandoned = await jq.forceAbandonJob(project.slug, heldId)
      assert.equal(abandoned.status, 'cancelled')
      assert.ok(abandoned.force_abandoned)
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true, 'abandoning terminalizes the row before its worker settles')
      const snapshot = structuredClone(jq.getJob(heldId))
      assert.ok(snapshot, 'the abandoned row stays in history while its worker settles')

      refusal(() => jq.retryTerminalJob(project.slug, heldId))
      refusal(() => jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'fresh action beside the abandon',
        params: { ...savedParams, operation_id: 'operation-2', generation_action: { id: 'action-2', kind: 'fresh' } },
        dedupeParams: params => params?.generation_action?.id === 'action-2',
      }))
      assert.deepEqual(jq.getJob(heldId), snapshot, 'the refused attempts leave the settling row byte-for-byte intact')
      assert.deepEqual(snapshot?.params, savedParams, 'saved operation, model and action identities are preserved')
      assert.equal(snapshot?.genstudio_jobs?.[0]?.id, 'provider-image-1')
      assert.equal(snapshot?.genstudio_jobs?.[0]?.request?.idempotency_key, 'provider-key-1')
    } finally {
      await releaseAndSettle(gate, original?.job_id)
    }

    // The row is kept (force_abandoned exempts the unsettled-evidence gate).
    const retried = track(jq.retryTerminalJob(project.slug, original!.job_id))
    assert.notEqual(retried.job_id, original!.job_id)
    assert.deepEqual(retried.params, savedParams, 'Retry carries the accepted params exactly')
    await waitFor(() => jq.getJob(retried.job_id)?.status === 'done', { label: 'the admitted retry to finish' })
  })

  test('generic Retry: refused while the failed worker settles, then replays the saved provider action exactly', async () => {
    const project = await newProject('Queue Admission Exact Replay')
    const episode = 'EP-EXACT'
    const gate = fixtureGate()
    const entered = signal()
    let heldId = ''
    const savedParams = {
      episode_id: episode,
      model: 'saved-metadata-model',
      auto_retry: false,
      generation_action: { id: '44444444-4444-4444-8444-444444444444', kind: 'fresh', origin: 'retry' },
      generation_action_fingerprint: 'e'.repeat(64),
    }
    const replayed: Array<Record<string, any>> = []
    useExecutor('metadata', async job => {
      if (job.job_id === heldId) {
        job.genstudio_jobs = [{
          id: 'chat-saved-answer',
          operation: 'chat.response',
          model_id: 'm',
          state: 'succeeded',
          updated_at: new Date().toISOString(),
          request: {
            method: 'POST',
            path: '/v1/chat/responses',
            idempotency_key: 'story-chat-saved-key',
            captured_at: new Date().toISOString(),
          },
        }]
        job.status = 'error'
        job.error = 'metadata failed after the saved answer'
        entered.fire()
        await gate.promise
        throw new Error('metadata failed after the saved answer')
      }
      replayed.push(structuredClone(job.params || {}))
      job.result = { complete: true }
    })

    let original: Job | undefined
    try {
      original = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'metadata', episode_id: episode,
        title: 'exact replay source', params: structuredClone(savedParams),
      }))
      heldId = original.job_id
      await awaitEntered(entered, 'the failed metadata worker to be held')
      assert.equal(jq.getJob(heldId)?.status, 'error')
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true)

      refusal(() => jq.retryTerminalJob(project.slug, heldId))
      assert.equal(jq.getJob(heldId)?.status, 'error', 'the refused Retry leaves the failed row in place')
    } finally {
      await releaseAndSettle(gate, original?.job_id)
    }

    const retried = track(jq.retryTerminalJob(project.slug, original!.job_id))
    assert.notEqual(retried.job_id, original!.job_id)
    assert.deepEqual(retried.params.generation_action, savedParams.generation_action,
      'the accepted Retry keeps the saved provider action')
    assert.equal(retried.params.generation_action_fingerprint, savedParams.generation_action_fingerprint)
    await waitFor(() => jq.getJob(retried.job_id)?.status === 'done', { label: 'the admitted exact replay to finish' })
    assert.ok(replayed[0], 'the retried executor ran')
    assert.deepEqual(replayed[0]!.generation_action, savedParams.generation_action,
      'the saved action id (and so its provider key) is replayed')
    assert.equal(replayed[0]!.generation_action_fingerprint, savedParams.generation_action_fingerprint)
    assert.equal(replayed[0]!.model, savedParams.model)
  })

  test('a finishing worker whose row already says done refuses a dedupeParams bypass, then admits it after the finally', async () => {
    const project = await newProject('Queue Admission Fresh Action')
    const episode = 'EP-FRESH'
    const gate = fixtureGate()
    const entered = signal()
    let heldId = ''
    useExecutor('thumb_images', async job => {
      job.result = { complete: true }
      if (job.job_id === heldId) {
        job.status = 'done' // terminal before runJob's finally, as a completing executor's own bookkeeping does
        entered.fire()
        await gate.promise
      }
    })

    let first: Job | undefined
    try {
      first = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'thumb_images', episode_id: episode,
        title: 'first thumb', params: { auto_retry: false, generation_action: { id: 'action-1', kind: 'fresh' } },
      }))
      heldId = first.job_id
      await awaitEntered(entered, 'the first thumb worker to terminalize while held')
      assert.equal(jq.getJob(heldId)?.status, 'done')
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true)

      // A predicate that matches no saved action is exactly the fresh-action
      // identity a caller uses for a deliberate second attempt.
      refusal(() => jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'thumb_images', episode_id: episode,
        title: 'fresh action', params: { auto_retry: false, generation_action: { id: 'action-2', kind: 'fresh' } },
        dedupeParams: params => params?.generation_action?.id === 'action-2',
      }))
    } finally {
      await releaseAndSettle(gate, first?.job_id)
    }

    const second = track(jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'thumb_images', episode_id: episode,
      title: 'fresh action after settlement',
      params: { auto_retry: false, generation_action: { id: 'action-3', kind: 'fresh' } },
      dedupeParams: params => params?.generation_action?.id === 'action-3',
    }))
    await waitFor(() => jq.getJob(second.job_id)?.status === 'done', { label: 'the admitted fresh action to finish' })
  })

  test('clearing the terminal history row does not hide the worker that is still settling', async () => {
    const project = await newProject('Queue Admission Cleared Row')
    const episode = 'EP-CLEARED'
    const gate = fixtureGate()
    const entered = signal()
    let heldId = ''
    useExecutor('broll_assemble', async job => {
      job.result = { complete: true }
      if (job.job_id === heldId) {
        job.status = 'done'
        entered.fire()
        await gate.promise
      }
    })

    let first: Job | undefined
    try {
      first = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'cleared while settling', params: { auto_retry: false },
      }))
      heldId = first.job_id
      await awaitEntered(entered, 'the row to terminalize while held')
      assert.equal(jq.removeTerminalJob(project.slug, heldId), true)
      assert.equal(jq.getJob(heldId), null, 'the history row is gone')
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true, 'its executor still runs')

      // The row is no longer in the jobs map, so the refusal must come from the
      // worker record the executor registered, not from a status lookup.
      refusal(() => jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'fresh beside the cleared row', params: { auto_retry: false },
      }))
    } finally {
      await releaseAndSettle(gate, first?.job_id)
    }

    const second = track(jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
      title: 'admitted after the cleared row settled', params: { auto_retry: false },
    }))
    await waitFor(() => jq.getJob(second.job_id)?.status === 'done', { label: 'the admitted job to finish' })
  })

  test('other episodes and other types are unaffected while a worker settles; refusals keep queue order', async () => {
    const project = await newProject('Queue Admission Noninterference')
    const heldEpisode = 'EP-HELD'
    const gate = fixtureGate()
    const entered = signal()
    let heldId = ''
    const runs: string[] = []
    useExecutor('broll_assemble', async job => {
      runs.push(job.job_id)
      job.result = { complete: true }
      if (job.job_id === heldId) {
        job.status = 'done'
        entered.fire()
        await gate.promise
      }
    })
    useExecutor('metadata', async job => {
      job.result = { complete: true }
    })

    let first: Job | undefined
    try {
      first = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: heldEpisode,
        title: 'held episode worker', params: { auto_retry: false },
      }))
      heldId = first.job_id
      await awaitEntered(entered, 'the held worker to terminalize')

      // Another episode of the same type is an independent scope: admitted now,
      // it simply waits for the single lane.
      const otherEpisode = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: 'EP-OTHER',
        title: 'another episode', params: { auto_retry: false },
      }))
      // A different type for the same episode is a different scope too, and
      // completes on its own lane during the hold.
      const otherType = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'metadata', episode_id: heldEpisode,
        title: 'another type', params: { auto_retry: false },
      }))
      await waitFor(() => jq.getJob(otherType.job_id)?.status === 'done', { label: 'the unrelated type to run during the hold' })

      refusal(() => jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: heldEpisode,
        title: 'refused same scope', params: { auto_retry: false },
      }))
      // The refusal inserted nothing: the queued sibling is next in lane order.
      await releaseAndSettle(gate, heldId)
      await waitFor(() => jq.getJob(otherEpisode.job_id)?.status === 'done', { label: 'the queued sibling to run after settlement' })
      assert.deepEqual(runs, [heldId, otherEpisode.job_id], 'the lane runs the held worker then the earlier-admitted sibling')
    } finally {
      await releaseAndSettle(gate, first?.job_id)
    }
  })

  test('episode recovery refuses an explicit retry on its own settling row, then resumes the same identity', async () => {
    const project = await newProject('Queue Admission Recovery Resume')
    const episode = 'EP-RECOVERY'
    const gate = fixtureGate()
    const entered = signal()
    const attempts = new Map<string, number>()
    // A subtitle row passes the automatic eligibility check below, so the
    // automatic call reaches the same-row active guard instead of returning at
    // the type gate. That is the branch B keeps as a no-op.
    useExecutor('subtitles_transcribe', async job => {
      const attempt = (attempts.get(job.job_id) || 0) + 1
      attempts.set(job.job_id, attempt)
      if (attempt === 1) {
        job.status = 'error'
        job.error = 'first attempt failed'
        job.genstudio_jobs = [{
          id: 'subtitle-provider-1',
          operation: 'audio.transcription',
          state: 'failed',
          updated_at: new Date().toISOString(),
          request: {
            method: 'POST',
            path: '/v1/audio/transcriptions',
            idempotency_key: 'subtitle-key-1',
            captured_at: new Date().toISOString(),
          },
        }]
        entered.fire()
        await gate.promise
        throw new Error('first attempt failed')
      }
      job.result = { complete: true }
    })

    let original: Job | undefined
    try {
      original = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'subtitles_transcribe', episode_id: episode,
        title: 'recovery attempt', params: {
          auto_retry: false,
          episode_recovery_id: 'recovery-1',
          subtitle_recovery: { sections: { first: { state: 'waiting_settlement' } } },
        },
      }))
      const jobId = original.job_id
      await awaitEntered(entered, 'the recovery row to show its failure while held')
      assert.equal(jq.getJob(jobId)?.status, 'error')
      assert.equal(jq._isJobWorkerActiveForTesting(jobId), true)
      const rowBefore = structuredClone(jq.getJob(jobId))
      assert.ok(rowBefore, 'the live error row is available before the refusal')
      const pauseBefore = { paused: jq.isQueuePaused(), owner: jq.getQueuePauseOwner() }

      await refusalAsync(() => jq.resumeEpisodeRecoveryJob(jobId, true),
        settlingMessage('subtitles_transcribe', episode))
      assert.equal(jq.getJob(jobId)?.status, 'error', 'the explicit retry refusal leaves the row unchanged')
      assert.equal(attempts.get(jobId), 1, 'no second executor started on the same row')

      // Automatic observation stays a silent no-op. No non-subtitle caller is
      // guaranteed another pass, and a no-op must not report a requeue.
      await jq.resumeEpisodeRecoveryJob(jobId)
      assert.equal(jq.getJob(jobId)?.status, 'error')
      assert.equal(attempts.get(jobId), 1)
      assert.deepEqual(jq.getJob(jobId), rowBefore,
        'the explicit refusal and automatic no-op leave the row byte-for-byte intact')
      assert.deepEqual(jq.getJob(jobId)?.params, rowBefore.params,
        'params and the recovery identity are unchanged')
      assert.deepEqual(jq.getJob(jobId)?.genstudio_jobs, rowBefore.genstudio_jobs,
        'provider evidence is unchanged')
      assert.deepEqual({ paused: jq.isQueuePaused(), owner: jq.getQueuePauseOwner() }, pauseBefore,
        'the refusals do not disturb the owner pause state')

      await releaseAndSettle(gate, jobId)
      assert.equal(jq.getJob(jobId)?.status, 'error', 'the row must still be resumable after settlement')

      await jq.resumeEpisodeRecoveryJob(jobId, true)
      await waitFor(() => jq.getJob(jobId)?.status === 'done', { label: 'the resumed recovery job to complete' })
      assert.equal(attempts.get(jobId), 2)
      assert.equal(jq.getJob(jobId)?.job_id, jobId, 'the admitted retry keeps the same durable identity')
      assert.equal(jq.getJob(jobId)?.params?.episode_recovery_id, 'recovery-1')
      assert.deepEqual(jq.getJob(jobId)?.params, rowBefore.params,
        'the admitted retry keeps the accepted params exactly')
      assert.deepEqual(jq.getJob(jobId)?.genstudio_jobs, rowBefore.genstudio_jobs,
        'the admitted retry keeps the provider evidence')
    } finally {
      await releaseAndSettle(gate, original?.job_id)
    }
  })

  test('episode recovery refuses another same-scope row, and a refused resume preserves an owner pause', async () => {
    const project = await newProject('Queue Admission Recovery Cross Row')
    const episode = 'EP-RECOVERY-CROSS'
    const gateB = fixtureGate()
    const gateC = fixtureGate()
    const enteredB = signal()
    const enteredC = signal()
    let aId = ''
    let bId = ''
    let cId = ''
    const attempts = new Map<string, number>()
    useExecutor('broll_assemble', async job => {
      const attempt = (attempts.get(job.job_id) || 0) + 1
      attempts.set(job.job_id, attempt)
      if (job.job_id === aId) {
        if (attempt === 1) throw new Error('recovery attempt failed')
        job.result = { complete: true }
        return
      }
      if (job.job_id === bId) {
        job.status = 'error'
        job.error = 'cross-row worker failed'
        enteredB.fire()
        await gateB.promise
        throw new Error('cross-row worker failed')
      }
      if (job.job_id === cId) {
        enteredC.fire()
        await gateC.promise
        job.result = { complete: true }
      }
    })

    let paused = false
    let a: Job | undefined
    try {
      a = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'recovery target', params: { auto_retry: false, episode_recovery_id: 'recovery-cross' },
      }))
      aId = a.job_id
      await waitFor(() => jq.getJob(aId)?.status === 'error' && !jq._isJobWorkerActiveForTesting(aId),
        { label: 'the recovery target to fail and settle' })

      // A different row for the same scope is terminal while its executor
      // still runs: the own-ID guard cannot see it, admission must.
      const b = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'settling cross-row worker', params: { auto_retry: false },
      }))
      bId = b.job_id
      await awaitEntered(enteredB, 'the cross-row worker to fail while held')
      await refusalAsync(() => jq.resumeEpisodeRecoveryJob(aId, true), settlingMessage('broll_assemble', episode))
      assert.equal(jq.getJob(aId)?.status, 'error')
      assert.equal(attempts.get(aId), 1, 'the settling cross-row worker blocks a second executor')
      await releaseAndSettle(gateB, bId)

      // A running row is refused by the same shared admission (isDuplicate),
      // not only by the terminal-active helper.
      const c = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
        title: 'running cross-row worker', params: { auto_retry: false },
      }))
      cId = c.job_id
      await awaitEntered(enteredC, 'the running cross-row worker to start')

      // Fixture-only owner pause: the refusal must not disturb intake state or
      // invent an updater owner.
      await jq.setQueuePaused(true)
      paused = true
      assert.equal(jq.isQueuePaused(), true)
      assert.equal(jq.getQueuePauseOwner(), null)
      // A running cross-row worker is the ordinary duplicate case, so this keeps
      // DuplicateJobError's original queued/running wording.
      await refusalAsync(() => jq.resumeEpisodeRecoveryJob(aId, true),
        `broll_assemble generation already queued/running for ${episode}`)
      assert.equal(jq.isQueuePaused(), true, 'the refused resume leaves the owner pause in force')
      assert.equal(jq.getQueuePauseOwner(), null, 'the refused resume does not claim the pause owner')
      assert.equal(jq.getJob(aId)?.status, 'error')
      assert.equal(attempts.get(aId), 1)

      await jq.setQueuePaused(false)
      paused = false
      await releaseAndSettle(gateC, cId)
    } finally {
      if (paused) await jq.setQueuePaused(false)
      await releaseAndSettle(gateB, bId)
      await releaseAndSettle(gateC, cId)
    }

    await jq.resumeEpisodeRecoveryJob(aId, true)
    await waitFor(() => jq.getJob(aId)?.status === 'done', { label: 'the recovery target to resume after settlement' })
    assert.equal(attempts.get(aId), 2)
  })

  test('a repeated same-type Pipeline link is still handed off while its terminal parent settles', async () => {
    const project = await newProject('Queue Admission Chain Repeat')
    // A real episode code is letters-then-digits; the chain link re-enqueues
    // through `enqueue`, which now asks §8 admission.
    const episode = 'EPCHAIN1'
    const ranIds: string[] = []
    useExecutor('broll_assemble', async job => {
      ranIds.push(job.job_id)
      if (ranIds.length === 1) throw new Error('first chain link failed')
      job.result = { complete: true }
    })

    const parent = track(jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
      title: 'first chain link',
      params: {
        auto_retry: false,
        pipeline_step: 'broll',
        pipeline_chain: [{
          type: 'broll_assemble',
          title: 'second chain link of the same type',
          params: { pipeline_step: 'broll_again', pipeline_requires: [] },
        }],
      },
    }))

    await waitFor(() => ranIds.length === 2, { label: 'the repeated same-type chain link to start' })
    await waitFor(() => {
      const linkId = ranIds[1]
      return Boolean(linkId) && jq.getJob(linkId!)?.status === 'done'
    }, { label: 'the chain link to finish' })
    assert.equal(jq.getJob(parent.job_id)?.status, 'error', 'the parent settles as failed')
    const linkId = ranIds[1]!
    const link = jq.getJob(linkId)
    if (link) track(link)

    const all = await jq.getJobs(project.slug)
    assert.equal(all.filter(job => job.params?.pipeline_handoff_failed).length, 0,
      'the parent\'s own handoff is never refused by the settlement guard')
    assert.equal(all.filter(job => !job.params?.pipeline_handoff_failed && job.type === 'broll_assemble').length, 2,
      'only the parent and its chained link exist')
  })

  test('Finish missing images refuses a different terminal-active Scene Review worker, then admits after settlement', async () => {
    const project = await newProject('Queue Admission Finish Missing')
    const episode = 'EP-FINISH'
    const gate = fixtureGate()
    const entered = signal()
    let failedId = ''
    let heldId = ''
    useExecutor('continuity_render', async job => {
      if (job.job_id === failedId) throw new Error('scene render failed')
      job.result = { complete: true }
      if (job.job_id === heldId) {
        job.status = 'done'
        entered.fire()
        await gate.promise
      }
    })

    let held: Job | undefined
    try {
      const failed = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'failed render', params: { auto_retry: false, model: 'mock-image-v1' },
      }))
      failedId = failed.job_id
      await waitFor(() => jq.getJob(failedId)?.status === 'error'
        && !jq._isJobWorkerActiveForTesting(failedId), { label: 'the failed scene render to settle' })
      await jq._waitForJobPersistenceForTesting()

      held = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'second render still settling', params: { auto_retry: false, model: 'mock-image-v1' },
      }))
      heldId = held.job_id
      await awaitEntered(entered, 'the second render to terminalize while held')
      assert.equal(jq.getJob(heldId)?.status, 'done')
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true)

      // The failed row is not the settling worker, so only the shared
      // terminal-active scope can refuse this direct requeue.
      await refusalAsync(() => jq.finishMissingImagesInPlace(project.slug, failedId))
      assert.equal(jq.getJob(failedId)?.status, 'error', 'the refused requeue did not touch the failed row')
    } finally {
      await releaseAndSettle(gate, held?.job_id)
    }

    const requeued = await jq.finishMissingImagesInPlace(project.slug, failedId)
    trackOutcome(requeued)
    assert.equal(requeued.reused, false)
    assert.equal(requeued.job.job_id, failedId, 'Finish missing images reuses the same durable row')
    await waitFor(() => !jq._isJobWorkerActiveForTesting(failedId)
      && jq.getJob(failedId)?.status === 'error', { label: 'the requeued worker to settle' })
  })

  test('Finish missing images rechecks the live worker inside the mutation window', async () => {
    const project = await newProject('Queue Admission Finish Mutation Race')
    const episode = 'EP-RACE'
    const gate = fixtureGate()
    const releaseStatus = fixtureGate()
    const entered = signal()
    let failedId = ''
    let heldId = ''
    useExecutor('continuity_render', async job => {
      if (job.job_id === failedId) throw new Error('scene render failed')
      if (job.job_id === heldId) {
        entered.fire()
        await releaseStatus.promise
        job.status = 'done'
        await gate.promise
        return
      }
      job.result = { complete: true }
    })

    const failed = track(jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'continuity_render', episode_id: episode,
      title: 'failed render', params: { auto_retry: false, model: 'mock-image-v1' },
    }))
    failedId = failed.job_id
    await waitFor(() => jq.getJob(failedId)?.status === 'error'
      && !jq._isJobWorkerActiveForTesting(failedId), { label: 'the failed scene render to settle' })
    await jq._waitForJobPersistenceForTesting()

    const held = track(jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'continuity_render', episode_id: episode,
      title: 'worker terminalizing during the mutation', params: { auto_retry: false, model: 'mock-image-v1' },
    }))
    heldId = held.job_id
    await awaitEntered(entered, 'the cross-row scene worker to start')
    await jq._waitForJobPersistenceForTesting()
    // Force the next authoritative mutation to hydrate, so the test can place
    // the terminal transition exactly between the outer check and the transform.
    jq._forgetProjectPersistenceForTesting(project.slug)

    let injected = false
    restores.push(jq._setJobFileLockProbeForTesting(async (stage, jobsFile) => {
      if (stage !== 'hydrate' || injected || !jobsFile.endsWith(`${project.slug}/jobs.json`)) return
      injected = true
      releaseStatus.open()
      await waitFor(() => jq.getJob(heldId)?.status === 'done' && jq._isJobWorkerActiveForTesting(heldId),
        { label: 'the cross-row worker to terminalize inside the mutation window' })
    }))

    try {
      await refusalAsync(() => jq.finishMissingImagesInPlace(project.slug, failedId))
      assert.equal(injected, true, 'the mutation window was exercised')
      assert.equal(jq.getJob(failedId)?.status, 'error', 'the refused requeue leaves the failed row untouched')
    } finally {
      releaseStatus.open()
      await releaseAndSettle(gate, heldId)
    }
  })

  test('queued/running chapter-writer semantics are unchanged: different chapters of one episode still queue', async () => {
    const project = await newProject('Queue Admission Chapter Predicate')
    const episode = 'EP-CHAPTERS'
    const gate = fixtureGate()
    const entered = signal()
    let heldId = ''
    const chapters: number[] = []
    const sameChapter = (chapter: number) => (params: any) => params?.chapter_number === chapter
    useExecutor('chapter-only', async job => {
      const chapter = Number(job.params?.chapter_number)
      chapters.push(chapter)
      job.result = { complete: true }
      if (job.job_id === heldId) {
        entered.fire()
        await gate.promise
      }
    })

    let first: Job | undefined
    try {
      first = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'chapter-only', episode_id: episode,
        title: 'chapter 1', params: { auto_retry: false, chapter_number: 1 },
        dedupeParams: sameChapter(1),
      }))
      heldId = first.job_id
      await awaitEntered(entered, 'chapter 1 executor to start')

      // A running row still dedupes by the caller's identity predicate.
      refusal(() => jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'chapter-only', episode_id: episode,
        title: 'chapter 1 again', params: { auto_retry: false, chapter_number: 1 },
        dedupeParams: sameChapter(1),
      }))
      // A different chapter is a deliberate distinct job and stays admitted.
      const second = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'chapter-only', episode_id: episode,
        title: 'chapter 2', params: { auto_retry: false, chapter_number: 2 },
        dedupeParams: sameChapter(2),
      }))
      assert.equal(jq.getJob(second.job_id)?.status, 'queued')
      await releaseAndSettle(gate, heldId)
      await waitFor(() => jq.getJob(second.job_id)?.status === 'done', { label: 'chapter 2 to run after chapter 1' })
      assert.deepEqual(chapters, [1, 2], 'the single chapter lane keeps FIFO order')
    } finally {
      await releaseAndSettle(gate, first?.job_id)
    }
  })

  test('enqueueOrRun async admission is refused during the terminal-active window, then admitted after settlement', async () => {
    const project = await newProject('Queue Admission EnqueueOrRun')
    const episode = 'EPORUN1'
    const gate = fixtureGate()
    const entered = signal()
    let heldId = ''
    useExecutor('broll_assemble', async job => {
      job.result = { complete: true }
      if (job.job_id === heldId) {
        job.status = 'done'
        entered.fire()
        await gate.promise
      }
    })

    const held = track(jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
      title: 'queued worker', params: { auto_retry: false },
    }))
    heldId = held.job_id
    await awaitEntered(entered, 'the queued worker to terminalize while held')

    // The default (async) adapter is a queue admission; only the dormant
    // `sync: true` one-shot bypasses the queue (no production call site emits it).
    await refusalAsync(() => jq.enqueueOrRun({
      project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
      title: 'async one-shot', params: { auto_retry: false },
    }))

    await releaseAndSettle(gate, heldId)
    const admitted = track(await jq.enqueueOrRun({
      project_slug: project.slug, type: 'broll_assemble', episode_id: episode,
      title: 'async one-shot after settlement', params: { auto_retry: false },
    }))
    await waitFor(() => jq.getJob(admitted.job_id)?.status === 'done', { label: 'the admitted enqueueOrRun job to finish' })
  })

  test('Finish missing images waits out a single-scene worker that terminalizes during its durable write', async () => {
    const project = await newProject('Queue Finish Fence Race')
    const episode = 'EP-FENCE-RACE'
    const attempts = new Map<string, number>()
    const finishRuns: Array<Record<string, any>> = []
    const statusGate = fixtureGate()
    const holdGate = fixtureGate()
    const entered = signal()
    let failedId = ''
    let heldId = ''
    useExecutor('continuity_render', async job => {
      const attempt = (attempts.get(job.job_id) || 0) + 1
      attempts.set(job.job_id, attempt)
      if (job.job_id === failedId) {
        if (attempt === 1) {
          job.genstudio_jobs = [{
            id: 'provider-image-fence',
            operation: 'image.generation',
            state: 'succeeded',
            updated_at: new Date().toISOString(),
            request: {
              method: 'POST',
              path: '/v1/images',
              idempotency_key: 'provider-key-fence',
              captured_at: new Date().toISOString(),
            },
          }]
          throw new Error('scene render failed')
        }
        finishRuns.push(structuredClone(job.params || {}))
        job.result = { complete: true }
        return
      }
      if (job.job_id === heldId) {
        entered.fire()
        await statusGate.promise
        job.status = 'done'
        await holdGate.promise
        job.result = { complete: true }
      }
    })

    const previousConcurrency = jq.getImageEpisodeConcurrency()
    jq.setImageEpisodeConcurrency(2)
    let raced = false
    let restoreProbe: (() => void) | undefined
    try {
      const failed = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'failed render', params: { auto_retry: false, model: 'mock-image-v1' },
      }))
      failedId = failed.job_id
      await awaitFailedContinuity(failedId)

      const held = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'single-scene sibling', params: {
          auto_retry: false, model: 'mock-image-v1', single_scene_id: 'scene-1',
        },
      }))
      heldId = held.job_id
      await awaitEntered(entered, 'the single-scene sibling executor to start')
      await jq._waitForJobPersistenceForTesting()

      // Terminalize the sibling only after the inner admission check ran and
      // while the durable write is in flight. It remains a live worker until
      // runJob's finally, which is exactly the window a status-only guard misses.
      restoreProbe = jq._setJobFileLockProbeForTesting(async (stage, jobsFile) => {
        if (stage !== 'persist' || raced || !jobsFile.endsWith(`${project.slug}/jobs.json`)) return
        raced = true
        statusGate.open()
        await waitFor(() => jq.getJob(heldId)?.status === 'done'
          && jq._isJobWorkerActiveForTesting(heldId),
        { label: 'the single-scene worker to terminalize inside the durable write' })
      })

      const requeued = await jq.finishMissingImagesInPlace(project.slug, failedId)
      trackOutcome(requeued)
      assert.equal(raced, true, 'the durable-write window was exercised')
      assert.equal(requeued.reused, false)
      assert.equal(requeued.job.job_id, failedId, 'Finish missing images keeps the same durable row')
      await assertFinishDeferred(project.slug, failedId, attempts, 1)
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true,
        'the predecessor is still inside its executor after writing done')
      assert.equal(jq.getJob(failedId)?.genstudio_jobs?.[0]?.request?.idempotency_key, 'provider-key-fence',
        'the waiting row keeps the provider identity it must replay')

      holdGate.open()
      await waitFor(() => !jq._isJobWorkerActiveForTesting(heldId), { label: 'the single-scene worker to settle' })
      await waitFor(() => jq.getJob(failedId)?.status === 'done'
        && !jq._isJobWorkerActiveForTesting(failedId), { label: 'the fenced Finish row to run once after release' })
      assert.equal(attempts.get(failedId), 2, 'the row ran exactly once after the natural release')
      assert.equal(finishRuns.length, 1)
      assert.equal(finishRuns[0]?.missing_only, true)
      assert.ok(finishRuns[0]?.jobs_finish_missing_images)
      assert.equal(finishRuns[0]?.model, 'mock-image-v1')
    } finally {
      statusGate.open()
      holdGate.open()
      restoreProbe?.()
      jq.setImageEpisodeConcurrency(previousConcurrency)
    }
  })

  test('Finish missing images is deferred while a single-scene sibling is actually running', async () => {
    const project = await newProject('Queue Finish Fence Running')
    const episode = 'EP-FENCE-RUNNING'
    const attempts = new Map<string, number>()
    const holdGate = fixtureGate()
    const entered = signal()
    let failedId = ''
    let heldId = ''
    useExecutor('continuity_render', async job => {
      const attempt = (attempts.get(job.job_id) || 0) + 1
      attempts.set(job.job_id, attempt)
      if (job.job_id === failedId) {
        if (attempt === 1) throw new Error('scene render failed')
        job.result = { complete: true }
        return
      }
      if (job.job_id === heldId) {
        entered.fire()
        await holdGate.promise
        job.result = { complete: true }
      }
    })

    const previousConcurrency = jq.getImageEpisodeConcurrency()
    jq.setImageEpisodeConcurrency(2)
    try {
      const failed = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'failed render', params: { auto_retry: false, model: 'mock-image-v1' },
      }))
      failedId = failed.job_id
      await awaitFailedContinuity(failedId)

      const held = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'running single-scene sibling', params: {
          auto_retry: false, model: 'mock-image-v1', single_scene_id: 'scene-1',
        },
      }))
      heldId = held.job_id
      await awaitEntered(entered, 'the running single-scene sibling to start')
      assert.equal(jq.getJob(heldId)?.status, 'running')

      const requeued = await jq.finishMissingImagesInPlace(project.slug, failedId)
      trackOutcome(requeued)
      assert.equal(requeued.reused, false)
      await assertFinishDeferred(project.slug, failedId, attempts, 1)
      assert.equal(jq._isJobWorkerActiveForTesting(heldId), true)

      holdGate.open()
      await waitFor(() => !jq._isJobWorkerActiveForTesting(heldId), { label: 'the running sibling to settle' })
      await waitFor(() => jq.getJob(failedId)?.status === 'done'
        && !jq._isJobWorkerActiveForTesting(failedId), { label: 'the deferred Finish row to run after release' })
      assert.equal(attempts.get(failedId), 2)
    } finally {
      holdGate.open()
      jq.setImageEpisodeConcurrency(previousConcurrency)
    }
  })

  test('cancelling a fenced Finish missing images row while it waits starts no executor later', async () => {
    const project = await newProject('Queue Finish Fence Cancel')
    const episode = 'EP-FENCE-CANCEL'
    const attempts = new Map<string, number>()
    const holdGate = fixtureGate()
    const entered = signal()
    let failedId = ''
    let heldId = ''
    useExecutor('continuity_render', async job => {
      const attempt = (attempts.get(job.job_id) || 0) + 1
      attempts.set(job.job_id, attempt)
      if (job.job_id === failedId) {
        if (attempt === 1) throw new Error('scene render failed')
        job.result = { complete: true }
        return
      }
      if (job.job_id === heldId) {
        entered.fire()
        await holdGate.promise
        job.result = { complete: true }
      }
    })

    const previousConcurrency = jq.getImageEpisodeConcurrency()
    jq.setImageEpisodeConcurrency(2)
    try {
      const failed = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'failed render', params: { auto_retry: false, model: 'mock-image-v1' },
      }))
      failedId = failed.job_id
      await awaitFailedContinuity(failedId)

      const held = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'single-scene sibling', params: {
          auto_retry: false, model: 'mock-image-v1', single_scene_id: 'scene-1',
        },
      }))
      heldId = held.job_id
      await awaitEntered(entered, 'the single-scene sibling to start')

      const requeued = await jq.finishMissingImagesInPlace(project.slug, failedId)
      trackOutcome(requeued)
      assert.equal(requeued.reused, false)
      await assertFinishDeferred(project.slug, failedId, attempts, 1)

      const cancelled = await jq.requestJobCancellation(project.slug, failedId)
      assert.equal(cancelled.status, 'cancelled')
      assert.equal(jq.getJob(failedId)?.status, 'cancelled')
      const row = (await jq.getJobs(project.slug)).find(job => job.job_id === failedId)
      assert.equal(row?.queue_position, undefined, 'the cancelled row left the pending lane')

      holdGate.open()
      await waitFor(() => !jq._isJobWorkerActiveForTesting(heldId), { label: 'the sibling to settle' })
      await jq._waitForJobPersistenceForTesting()
      assert.equal(attempts.get(failedId), 1, 'no executor started for the cancelled row')
      assert.equal(jq.getJob(failedId)?.status, 'cancelled')
    } finally {
      holdGate.open()
      jq.setImageEpisodeConcurrency(previousConcurrency)
    }
  })

  test('a failed Finish durable write does not dispatch or change the live/disk row', async () => {
    const project = await newProject('Queue Finish Fence Persist Failure')
    const episode = 'EP-FENCE-PERSIST'
    const attempts = new Map<string, number>()
    let failedId = ''
    useExecutor('continuity_render', async job => {
      const attempt = (attempts.get(job.job_id) || 0) + 1
      attempts.set(job.job_id, attempt)
      if (job.job_id === failedId && attempt === 1) throw new Error('scene render failed')
      job.result = { complete: true }
    })

    const previousConcurrency = jq.getImageEpisodeConcurrency()
    jq.setImageEpisodeConcurrency(2)
    let injected = false
    let restoreProbe: (() => void) | undefined
    let repairRow: Job | undefined
    try {
      const failed = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'failed render', params: { auto_retry: false, model: 'mock-image-v1' },
      }))
      failedId = failed.job_id
      await awaitFailedContinuity(failedId)
      // Capture the exact pre-attempt source row. The finally repairs the
      // staged baseline with this row, never with whatever the live row
      // happens to be if the Finish attempt unexpectedly succeeds.
      const sourceRow = jq.getJob(failedId)
      assert.ok(sourceRow, 'the failed source row exists before the Finish attempt')
      repairRow = structuredClone(sourceRow)

      restoreProbe = jq._setJobFileLockProbeForTesting(async (stage, jobsFile) => {
        if (stage !== 'persist' || injected || !jobsFile.endsWith(`${project.slug}/jobs.json`)) return
        injected = true
        throw new Error('injected persistence failure')
      })

      let outcome: { value: unknown } | { error: unknown }
      try {
        outcome = { value: await jq.finishMissingImagesInPlace(project.slug, failedId) }
      } catch (error) {
        outcome = { error }
      }
      if ('value' in outcome) {
        // An unexpected success may have admitted an executor. Track its row
        // before failing so cleanup waits for it.
        trackOutcome(outcome.value)
        assert.fail('the injected durable-write failure was not reported; Finish unexpectedly succeeded')
      }
      assert.equal(injected, true, 'the durable-write failure was injected')
      assert.equal((outcome.error as any)?.message, 'injected persistence failure')
      assert.equal(jq.getJob(failedId)?.status, 'error', 'the live row is unchanged')
      assert.equal(jq._isJobWorkerActiveForTesting(failedId), false)
      assert.equal(attempts.get(failedId), 1)
      const row = (await jq.getJobs(project.slug)).find(job => job.job_id === failedId)
      assert.equal(row?.status, 'error')
      assert.equal(row?.queue_position, undefined, 'nothing was pushed to pending')
      assert.equal((await jq.loadAuthoritativeJob(project.slug, failedId))?.status, 'error',
        'the failed write never reached disk')
    } finally {
      restoreProbe?.()
      restoreProbe = undefined
      if (injected && repairRow) {
        // Known pre-existing writer behaviour, reported as a limit rather than
        // changed here: applyProjectMutation already staged `queued` in the
        // in-memory baseline before the durable write failed. Wait out any
        // executor an unexpected success admitted, then restore the exact
        // pre-attempt error row through the existing write seam so a later
        // drain cannot flush an orphaned queued row.
        await waitFor(() => !jq._isJobWorkerActiveForTesting(failedId),
          { label: 'the Finish row worker to settle before repairing the staged row' })
        await jq.writeAuthoritativeJob(repairRow)
        await jq._waitForJobPersistenceForTesting()
      }
      jq.setImageEpisodeConcurrency(previousConcurrency)
    }
  })

  test('an owner pause survives the fenced wait and the natural release still starts the Finish row', async () => {
    const project = await newProject('Queue Finish Fence Pause')
    const episode = 'EP-FENCE-PAUSE'
    const attempts = new Map<string, number>()
    const statusGate = fixtureGate()
    const holdGate = fixtureGate()
    const entered = signal()
    let failedId = ''
    let heldId = ''
    useExecutor('continuity_render', async job => {
      const attempt = (attempts.get(job.job_id) || 0) + 1
      attempts.set(job.job_id, attempt)
      if (job.job_id === failedId) {
        if (attempt === 1) throw new Error('scene render failed')
        job.result = { complete: true }
        return
      }
      if (job.job_id === heldId) {
        entered.fire()
        await statusGate.promise
        job.status = 'done'
        await holdGate.promise
        job.result = { complete: true }
      }
    })

    const previousConcurrency = jq.getImageEpisodeConcurrency()
    jq.setImageEpisodeConcurrency(2)
    let paused = false
    try {
      const failed = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'failed render', params: { auto_retry: false, model: 'mock-image-v1' },
      }))
      failedId = failed.job_id
      await awaitFailedContinuity(failedId)

      const held = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'single-scene sibling', params: {
          auto_retry: false, model: 'mock-image-v1', single_scene_id: 'scene-1',
        },
      }))
      heldId = held.job_id
      await awaitEntered(entered, 'the single-scene sibling to start')

      const requeued = await jq.finishMissingImagesInPlace(project.slug, failedId)
      trackOutcome(requeued)
      assert.equal(requeued.reused, false)
      await assertFinishDeferred(project.slug, failedId, attempts, 1)

      statusGate.open()
      await waitFor(() => jq.getJob(heldId)?.status === 'done' && jq._isJobWorkerActiveForTesting(heldId),
        { label: 'the sibling to terminalize before the pause' })
      await jq.setQueuePaused(true)
      paused = true
      assert.equal(jq.isQueuePaused(), true)
      assert.equal(jq.getQueuePauseOwner(), null)

      holdGate.open()
      await waitFor(() => !jq._isJobWorkerActiveForTesting(heldId), { label: 'the sibling to settle under pause' })
      assert.equal(jq.getJob(failedId)?.status, 'queued')
      assert.equal(jq._isJobWorkerActiveForTesting(failedId), false)
      assert.equal(attempts.get(failedId), 1)
      assert.equal((await jq.getJobs(project.slug)).find(job => job.job_id === failedId)?.queue_position, 1)
      assert.equal(jq.isQueuePaused(), true, 'the release pump did not lift the owner pause')
      assert.equal(jq.getQueuePauseOwner(), null)

      await jq.setQueuePaused(false)
      paused = false
      await waitFor(() => jq.getJob(failedId)?.status === 'done'
        && !jq._isJobWorkerActiveForTesting(failedId), { label: 'the Finish row to start after Resume' })
      assert.equal(attempts.get(failedId), 2)
    } finally {
      statusGate.open()
      holdGate.open()
      jq.setImageEpisodeConcurrency(previousConcurrency)
      if (paused) await jq.setQueuePaused(false)
    }
  })

  test('a blocked Finish row does not hold the other image lane, which keeps its own FIFO', async () => {
    const project = await newProject('Queue Finish Fence Other Lane')
    const episode = 'EP-FENCE-LANE'
    const attempts = new Map<string, number>()
    const poolRuns: string[] = []
    const holdGate = fixtureGate()
    const poolGate = fixtureGate()
    const entered = signal()
    const poolEntered = signal()
    let failedId = ''
    let heldId = ''
    let poolOneId = ''
    useExecutor('continuity_render', async job => {
      const attempt = (attempts.get(job.job_id) || 0) + 1
      attempts.set(job.job_id, attempt)
      if (job.job_id === failedId) {
        if (attempt === 1) throw new Error('scene render failed')
        job.result = { complete: true }
        return
      }
      if (job.job_id === heldId) {
        entered.fire()
        await holdGate.promise
        job.result = { complete: true }
      }
    })
    useExecutor('image_pool_generate', async job => {
      poolRuns.push(job.job_id)
      if (job.job_id === poolOneId) {
        poolEntered.fire()
        await poolGate.promise
      }
      job.result = { complete: true }
    })

    const previousConcurrency = jq.getImageEpisodeConcurrency()
    jq.setImageEpisodeConcurrency(2)
    try {
      const failed = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'failed render', params: { auto_retry: false, model: 'mock-image-v1' },
      }))
      failedId = failed.job_id
      await awaitFailedContinuity(failedId)

      const held = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: episode,
        title: 'single-scene sibling', params: {
          auto_retry: false, model: 'mock-image-v1', single_scene_id: 'scene-1',
        },
      }))
      heldId = held.job_id
      await awaitEntered(entered, 'the single-scene sibling to start')

      const requeued = await jq.finishMissingImagesInPlace(project.slug, failedId)
      trackOutcome(requeued)
      assert.equal(requeued.reused, false)
      await assertFinishDeferred(project.slug, failedId, attempts, 1)

      const poolItem = (id: string) => (params: any) => params?.pool_item === id
      const poolOne = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'image_pool_generate', episode_id: episode,
        title: 'pool one', params: { auto_retry: false, pool_item: 'one' },
        dedupeParams: poolItem('one'),
      }))
      poolOneId = poolOne.job_id
      await awaitEntered(poolEntered, 'the first pool job to hold its slot')
      assert.equal(jq.getJob(poolOne.job_id)?.status, 'running')
      // poolOne is running, not terminal-active, so the unconditional settling
      // guard cannot turn this second admission into a refusal: it waits only
      // because the shared image budget is full.
      const poolTwo = track(jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'image_pool_generate', episode_id: episode,
        title: 'pool two', params: { auto_retry: false, pool_item: 'two' },
        dedupeParams: poolItem('two'),
      }))
      assert.equal(jq.getJob(poolTwo.job_id)?.status, 'queued')
      poolGate.open()
      await waitFor(() => jq.getJob(poolOne.job_id)?.status === 'done'
        && jq.getJob(poolTwo.job_id)?.status === 'done',
      { label: 'both pool jobs to run while the Finish row is fenced' })
      assert.deepEqual(poolRuns, [poolOne.job_id, poolTwo.job_id],
        'the other image lane advances in its own FIFO order')
      assert.equal(jq.getJob(failedId)?.status, 'queued', 'the blocked Finish row waited through both')
      assert.equal(jq._isJobWorkerActiveForTesting(failedId), false)
      assert.equal(attempts.get(failedId), 1)

      holdGate.open()
      await waitFor(() => !jq._isJobWorkerActiveForTesting(heldId), { label: 'the single-scene sibling to settle' })
      await waitFor(() => jq.getJob(failedId)?.status === 'done'
        && !jq._isJobWorkerActiveForTesting(failedId), { label: 'the Finish row to run after the sibling' })
      assert.equal(attempts.get(failedId), 2)
    } finally {
      holdGate.open()
      poolGate.open()
      jq.setImageEpisodeConcurrency(previousConcurrency)
    }
  })
})
