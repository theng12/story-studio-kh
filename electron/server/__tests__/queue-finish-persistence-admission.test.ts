import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, afterEach, before, test } from 'node:test'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let cleanup: () => Promise<void>
const projects: string[] = []
const restores: Array<() => void> = []
const gates: Array<() => void> = []
function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  gates.push(open)
  return { promise, open }
}
before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})
afterEach(async () => {
  for (const open of gates.splice(0)) open()
  // Uncertainty assertions are complete before fixture-only abandonment. This
  // never repairs the failed-admission/later-flush/restart negative control.
  for (const slug of projects) {
    if (!jq._finishPersistenceStateForTesting?.(slug).uncertain) continue
    for (const row of await jq.getJobs(slug)) {
      if (row.status === 'queued') await jq.forceAbandonJob(slug, row.job_id).catch(() => {})
    }
    jq._forgetProjectPersistenceForTesting(slug)
  }
  await jq._waitForJobPersistenceForTesting()
  if (jq.isQueuePaused()) await jq.setQueuePaused(false)
  while (restores.length) restores.pop()!()
})
after(async () => { await jq._waitForJobPersistenceForTesting(); await cleanup() })

async function fixture(name: string) {
  const project = await pm.createProject({ name })
  projects.push(project.slug)
  let live!: Job
  restores.push(jq._setExecutorForTesting('continuity_render', async job => {
    live = job
    throw new Error('fixture image failure')
  }))
  const row = jq.enqueuePreparedForTest({ project_slug: project.slug, episode_id: 'EP-FINISH', type: 'continuity_render',
    params: { model: 'mock-image-v1', auto_retry: false, nested: { keep: 1, remove: 2 } } })
  await waitFor(() => Boolean(live) && jq.getJob(row.job_id)?.status === 'error'
    && !jq._isJobWorkerActiveForTesting(row.job_id), { label: 'fixture failed executor settlement' })
  await jq._waitForJobPersistenceForTesting()
  await jq.setQueuePaused(true)
  const file = path.join(pm.getProjectDir(project.slug)!, 'jobs.json')
  return { project, live, row, file, before: await jq.loadAuthoritativeJob(project.slug, row.job_id) }
}
async function disk(file: string): Promise<{ jobs: Job[]; [key: string]: unknown }> {
  const value = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.ok(Array.isArray(value.jobs))
  return value
}
function other(slug: string, id: string): Job {
  return { job_id: id, project_slug: slug, episode_id: id, type: 'broll_assemble', title: id, status: 'done',
    params: { auto_retry: false }, output_lines: [], created_at: '2026-10-18T00:00:00.000Z' } as Job
}
function provider(id: string) {
  return { id, operation: 'image.generation' as const, state: 'succeeded' as const,
    request_key: `story-${id}`, updated_at: '2026-10-18T00:00:00.000Z' }
}

// This is the actual RED: immediate disk state alone passes on the old writer.
test('unpublished Finish stays terminal after an unrelated successful flush and a fresh queue rejoin', async () => {
  const f = await fixture('Finish unpublished later flush')
  let injected = false
  const restore = jq._setJobFileLockProbeForTesting((stage, file) => {
    if (stage === 'persist' && file === f.file && !injected) { injected = true; throw new Error('unpublished Finish') }
  })
  try { await assert.rejects(jq.finishMissingImagesInPlace(f.project.slug, f.row.job_id), /unpublished Finish/) }
  finally { restore() }
  assert.equal(injected, true)
  await jq.writeAuthoritativeJob(other(f.project.slug, 'unrelated-success'))
  assert.deepEqual((await disk(f.file)).jobs.find(row => row.job_id === f.row.job_id), f.before)
  const positive = ['positive-first', 'positive-second'].map(id => ({ ...other(f.project.slug, id), status: 'queued' as const }))
  for (const row of positive) await jq.writeAuthoritativeJob(row)
  await jq._waitForJobPersistenceForTesting()
  const restarted = await import(`${pathToFileURL(path.resolve('server/services/job-queue.ts')).href}?finish-failure-rejoin`)
  const starts: string[] = []
  const reset = restarted._setExecutorForTesting('broll_assemble', async (job: Job) => { starts.push(job.job_id); job.result = { complete: true } })
  const resetImages = restarted._setExecutorForTesting('continuity_render', async () => { assert.fail('unaccepted Finish restarted') })
  try {
    const rows = await restarted.getJobs(f.project.slug)
    assert.equal(rows.find((row: Job) => row.job_id === f.row.job_id)?.status, 'error')
    assert.equal(rows.find((row: Job & { queue_position?: number }) => row.job_id === f.row.job_id)?.queue_position, undefined)
    await restarted.setQueuePaused(false)
    await waitFor(() => starts.length === 2 && positive.every(row => !restarted._isJobWorkerActiveForTesting(row.job_id)), { label: 'positive restart FIFO controls' })
    assert.deepEqual(starts, positive.map(row => row.job_id))
    await restarted._waitForJobPersistenceForTesting()
  } finally { reset(); resetImages() }
})

for (const success of [false, true]) test(`same-row provider and nested params survive ${success ? 'published' : 'unpublished'} admission and pending handoff`, async () => {
  const f = await fixture(`Finish observations ${success}`)
  const entered = gate()
  const release = gate()
  let held = false
  const restore = jq._setJobFileLockProbeForTesting(async (stage, file) => {
    if (stage !== 'persist' || file !== f.file || held) return
    held = true; entered.open(); await release.promise
    if (!success) throw new Error('observation write failed')
  })
  restores.push(restore)
  const finish = jq.finishMissingImagesInPlace(f.project.slug, f.row.job_id).then(value => ({ value }), error => ({ error }))
  await entered.promise
  delete f.live.params.nested.remove
  f.live.params.nested.added = { owner: 'new-request' }
  f.live.params.script_document_requests = { version: 1, requests: [{ request_key: 'story-owner', item: 'outline', episode_id: 'EP-FINISH' }] }
  const checkpoint = jq.checkpointJobState(f.live)
  const receipt = jq.recordGenStudioJob(f.row.job_id, provider('accepted-during-admission'))
  await waitFor(() => jq._finishPersistenceStateForTesting(f.project.slug).pending >= 2, { label: 'observations queued behind admission' })
  release.open()
  const outcome = await finish
  restore()
  if (success) assert.ok('value' in outcome)
  else assert.ok('error' in outcome && /observation write failed/.test(String(outcome.error)))
  await Promise.all([checkpoint, receipt])
  await jq._waitForJobPersistenceForTesting()
  const persisted = (await disk(f.file)).jobs.find(row => row.job_id === f.row.job_id)!
  assert.equal(persisted.status, success ? 'queued' : 'error')
  assert.equal(persisted.params.nested.remove, undefined)
  assert.deepEqual(persisted.params.nested.added, { owner: 'new-request' })
  assert.equal(persisted.params.script_document_requests.requests[0].request_key, 'story-owner')
  assert.equal(persisted.genstudio_jobs?.find(entry => entry.id === 'accepted-during-admission')?.request_key, 'story-accepted-during-admission')
  assert.equal(Boolean(persisted.params.jobs_finish_missing_images), success)
  if (success) await jq.requestJobCancellation(f.project.slug, f.row.job_id).catch(() => {})
})

test('actual old disk differs from dirty retained evidence; failed admission discards only queue intent', async () => {
  const f = await fixture('Finish dirty baseline')
  let failures = 0
  const restore = jq._setJobFileLockProbeForTesting((stage, file) => {
    if (stage === 'persist' && file === f.file && failures++ < 2) throw new Error('two prewrite failures')
  })
  try {
    await assert.rejects(jq.recordGenStudioJob(f.row.job_id, provider('retained-evidence')), /two prewrite/)
    await assert.rejects(jq.finishMissingImagesInPlace(f.project.slug, f.row.job_id), /two prewrite/)
  } finally { restore() }
  await jq.writeAuthoritativeJob(other(f.project.slug, 'flush-retained'))
  const row = (await disk(f.file)).jobs.find(row => row.job_id === f.row.job_id)!
  assert.equal(row.status, 'error')
  assert.equal(row.params.jobs_finish_missing_images, undefined)
  assert.equal(row.genstudio_jobs?.[0]?.id, 'retained-evidence')
})

test('later callbacks wait in invocation order, evaluate once, and neither drain misses a held transaction', async () => {
  const f = await fixture('Finish gate ordering')
  const entered = gate(); const release = gate()
  let held = false
  const restore = jq._setJobFileLockProbeForTesting(async (stage, file) => {
    if (stage !== 'persist' || file !== f.file || held) return
    held = true; entered.open(); await release.promise; throw new Error('ordered failure')
  })
  restores.push(restore)
  const finish = jq.finishMissingImagesInPlace(f.project.slug, f.row.job_id).catch(error => error)
  await entered.promise
  const calls: string[] = []
  const writes = ['first', 'second'].map(title => jq.mutateAuthoritativeJob(f.project.slug, f.row.job_id, row => {
    calls.push(title); return { ...row, title }
  }))
  let drained = false
  const drain = jq._waitForJobPersistenceForTesting().then(() => { drained = true })
  await waitFor(() => jq._finishPersistenceStateForTesting(f.project.slug).pending === 2, { label: 'both callbacks waiting' })
  assert.deepEqual(calls, [])
  assert.equal(drained, false)
  assert.equal(await jq.drainJobPersistenceForShutdown(0), false)
  release.open(); await finish; restore()
  await Promise.all(writes); await drain
  assert.deepEqual(calls, ['first', 'second'])
  assert.equal((await jq.loadAuthoritativeJob(f.project.slug, f.row.job_id))?.title, 'second')
})

test('rename then rejection finalizes the known published identity once', async () => {
  const f = await fixture('Finish rename ambiguity')
  const rename = fs.rename.bind(fs)
  let injected = false
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args)
    if (String(args[1]) === f.file && !injected) { injected = true; throw new Error('rename acknowledged late') }
  }
  try {
    const accepted = await jq.finishMissingImagesInPlace(f.project.slug, f.row.job_id)
    assert.equal(injected, true)
    assert.equal(accepted.job.job_id, f.row.job_id)
    assert.equal((await jq.getJobs(f.project.slug)).filter(row => row.job_id === f.row.job_id).length, 1)
    assert.equal((await jq.loadAuthoritativeJob(f.project.slug, f.row.job_id))?.status, 'queued')
    await jq.requestJobCancellation(f.project.slug, f.row.job_id)
  } finally { fs.rename = rename }
})

for (const kind of ['third', 'malformed', 'duplicate', 'read-error', 'conflict'] as const) test(`${kind} outcome fences writes, removal, dispatch and both drains`, async () => {
  const f = await fixture(`Finish uncertainty ${kind}`)
  const waiting = jq.enqueuePreparedForTest({ project_slug: f.project.slug, episode_id: 'waiting', type: 'broll_assemble', params: { auto_retry: false } })
  let starts = 0
  restores.push(jq._setExecutorForTesting('broll_assemble', async () => { starts++ }))
  await jq._waitForJobPersistenceForTesting()
  let injected = false
  const readFile = fs.readFile.bind(fs)
  let readFailure = false
  if (kind === 'read-error') {
    fs.readFile = ((...args: Parameters<typeof fs.readFile>) => {
      if (readFailure && String(args[0]) === f.file) return Promise.reject(Object.assign(new Error('fixture read refusal'), { code: 'EACCES' }))
      return readFile(...args)
    }) as typeof fs.readFile
  }
  const restore = jq._setJobFileLockProbeForTesting(async (stage, file) => {
    if (stage !== 'persist' || file !== f.file || injected) return
    injected = true
    if (kind === 'read-error') { readFailure = true; throw new Error('unknown read outcome') }
    if (kind === 'conflict') f.live.params.jobs_finish_missing_images = { action_id: 'concurrent-owner' }
    else await fs.writeFile(file, kind === 'malformed' ? '{broken' : JSON.stringify({ jobs: kind === 'duplicate' ? [f.before, f.before] : [f.before], unknown: { must: 'survive' } }))
    if (kind !== 'conflict') throw new Error('unknown write outcome')
  })
  try {
    await assert.rejects(jq.finishMissingImagesInPlace(f.project.slug, f.row.job_id), /could not be reconciled/)
    assert.equal(jq._finishPersistenceStateForTesting(f.project.slug).uncertain, true)
    readFailure = false
    const unchanged = await fs.readFile(f.file, 'utf8')
    await assert.rejects(jq.writeAuthoritativeJob(other(f.project.slug, 'blocked')), /could not be reconciled/)
    await assert.rejects(jq.withProjectJobRemovalGuard(f.project.slug, pm.getProjectDir(f.project.slug)!, async () => assert.fail('removed')), /could not be reconciled/)
    await assert.rejects(jq._waitForJobPersistenceForTesting(), /could not be reconciled/)
    assert.equal(await jq.drainJobPersistenceForShutdown(0), false)
    assert.throws(() => jq.enqueuePreparedForTest({ project_slug: f.project.slug, episode_id: 'other', type: 'broll_assemble', params: {} }), /could not be reconciled/)
    await jq.setQueuePaused(false)
    assert.equal(starts, 0)
    assert.equal(jq._isJobWorkerActiveForTesting(waiting.job_id), false)
    assert.equal((await jq.getJobs(f.project.slug)).find(row => row.job_id === waiting.job_id)?.queue_position, 1)
    assert.equal(await fs.readFile(f.file, 'utf8'), unchanged, 'no guessed rollback/overwrite')
  } finally { restore(); fs.readFile = readFile }
})

test('unknown disk rows and fields remain untouched when cached authority cannot explain them', async () => {
  const f = await fixture('Finish unknown disk row')
  const snapshot = await disk(f.file)
  snapshot.jobs.push({ ...other(f.project.slug, 'foreign-history'), extension: { retain: true } } as Job)
  snapshot.extension = { sequence: ['keep', 'ordered'] }
  await fs.writeFile(f.file, JSON.stringify(snapshot))
  const exact = await fs.readFile(f.file, 'utf8')
  await assert.rejects(jq.finishMissingImagesInPlace(f.project.slug, f.row.job_id), /could not be reconciled/)
  assert.equal(await fs.readFile(f.file, 'utf8'), exact)
})

test('project removal waits behind admission, then refuses the accepted pending owner', async () => {
  const f = await fixture('Finish removal gate')
  const entered = gate(); const release = gate()
  let held = false
  const restore = jq._setJobFileLockProbeForTesting(async (stage, file) => {
    if (stage !== 'persist' || file !== f.file || held) return
    held = true; entered.open(); await release.promise
  })
  restores.push(restore)
  const finish = jq.finishMissingImagesInPlace(f.project.slug, f.row.job_id)
  await entered.promise
  let removed = false
  const removal = jq.withProjectJobRemovalGuard(f.project.slug, pm.getProjectDir(f.project.slug)!, async () => { removed = true })
    .then(() => null, error => error)
  await waitFor(() => jq._finishPersistenceStateForTesting(f.project.slug).staging >= 2, { label: 'removal staged behind Finish' })
  assert.equal(removed, false)
  release.open(); await finish
  assert.match(String(await removal), /active or unsettled/)
  assert.equal(removed, false)
  restore()
  assert.equal(jq.isQueuePaused(), true, 'owner hold survived admission')
  await jq.requestJobCancellation(f.project.slug, f.row.job_id)
})

test('ordinary burst still coalesces and changed rows alone pay redaction cost', async () => {
  const f = await fixture('Finish ordinary cost')
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...other(f.project.slug, `ordinary-${i}`), status: 'queued' as const }))
  await Promise.all(rows.map(row => jq.writeAuthoritativeJob(row)))
  jq._resetJobPersistenceCountersForTesting()
  await Promise.all(rows.map(row => jq.writeAuthoritativeJob({ ...row, title: `changed-${row.title}` })))
  const counters = jq._getJobPersistenceCountersForTesting()
  assert.ok(counters.atomic_writes < rows.length, `burst became ${counters.atomic_writes} writes`)
  assert.ok(counters.safe_job_calls <= rows.length * 2 + 40, `whole baseline redacted ${counters.safe_job_calls} times`)
  assert.equal((await disk(f.file)).jobs.length, 41)
  await Promise.all(rows.map(row => jq.writeAuthoritativeJob({ ...row, status: 'cancelled' })))
})

test('a provider callback before Finish acquires staging cannot undo the published admission after flush and rejoin', async () => {
  const f = await fixture('Finish pre-staging observation')
  const readEntered = gate(); const releaseRead = gate()
  const stagingEntered = gate(); const releaseStaging = gate()
  // Pre-load the project so Finish's own loadPersistedJobs is a no-op and its
  // FIRST jobs.json read is the path-locked read inside loadAuthoritativeJob
  // (job-queue.ts:2535 withLock -> 2627 readStrictJobsSnapshot). Holding that
  // read holds the path lock, so the prior staging turn below queues behind it —
  // the pre-staging regression's real contention point. This must run BEFORE the
  // fs.readFile probe is installed, or the probe would hold this pre-load read.
  await jq.getJobs(f.project.slug)
  const readFile = fs.readFile.bind(fs)
  let held = false
  fs.readFile = ((...args: Parameters<typeof fs.readFile>) => {
    const reading = readFile(...args)
    if (String(args[0]) !== f.file || held) return reading
    held = true
    return reading.then(async value => { readEntered.open(); await releaseRead.promise; return value })
  }) as typeof fs.readFile
  const finish = jq.finishMissingImagesInPlace(f.project.slug, f.row.job_id)
  let prior: Promise<void> | undefined
  let receipt: Promise<void> | undefined
  try {
    await readEntered.promise
    // Finish holds the path lock for its initial read. This earlier staging
    // turn queues on that lock, then holds staging while Finish requests it.
    prior = jq.withProjectJobRemovalGuard(f.project.slug, pm.getProjectDir(f.project.slug)!, async () => {
      stagingEntered.open(); await releaseStaging.promise
    })
    await waitFor(() => jq._finishPersistenceStateForTesting(f.project.slug).staging === 1, { label: 'prior staging turn waiting on Finish read' })
    releaseRead.open()
    await stagingEntered.promise
    await waitFor(() => {
      const state = jq._finishPersistenceStateForTesting(f.project.slug)
      return state.transactions === 1 && state.staging >= 2
    }, { label: 'Finish requested but staging not acquired' })
    assert.equal(f.live.status, 'error')
    assert.equal(f.live.params.jobs_finish_missing_images, undefined)
    receipt = jq.recordGenStudioJob(f.row.job_id, provider('before-staging'))
    await waitFor(() => jq._finishPersistenceStateForTesting(f.project.slug).pending === 1, { label: 'pre-Finish callback snapshot queued after admission' })
    releaseStaging.open()
    const accepted = await finish
    await prior; await receipt
    await jq.writeAuthoritativeJob(other(f.project.slug, 'post-admission-flush'))
    await jq._waitForJobPersistenceForTesting()
    const persisted = (await disk(f.file)).jobs.find(row => row.job_id === f.row.job_id)!
    assert.equal(persisted.status, 'queued', 'pre-staging callback reverted acknowledged Finish to terminal')
    assert.deepEqual(persisted.params.jobs_finish_missing_images, accepted.job.params.jobs_finish_missing_images)
    assert.equal(persisted.genstudio_jobs?.find(entry => entry.id === 'before-staging')?.request_key, 'story-before-staging')
    const state = jq._finishPersistenceStateForTesting(f.project.slug)
    assert.equal(state.transactions, 0)
    assert.equal(state.staging, 0)
    assert.equal(state.pending, 0)
    const restarted = await import(`${pathToFileURL(path.resolve('server/services/job-queue.ts')).href}?finish-pre-staging-rejoin`)
    const reset = restarted._setExecutorForTesting('continuity_render', async () => { assert.fail('paused rejoin dispatched Finish') })
    try {
      const row = (await restarted.getJobs(f.project.slug)).find((row: Job) => row.job_id === f.row.job_id)!
      assert.equal(row.status, 'queued')
      assert.equal(row.queue_position, 1)
      assert.deepEqual(row.params.jobs_finish_missing_images, accepted.job.params.jobs_finish_missing_images)
      await assert.rejects(restarted.requestJobCancellation(f.project.slug, f.row.job_id), (error: unknown) => (error as { code?: string }).code === 'CANCELLATION_STATUS_UNKNOWN')
      await restarted._waitForJobPersistenceForTesting()
    } finally { reset() }
  } finally {
    fs.readFile = readFile
    releaseRead.open(); releaseStaging.open()
    await Promise.allSettled([finish, ...(prior ? [prior] : []), ...(receipt ? [receipt] : [])])
    if (jq.getJob(f.row.job_id)?.status === 'queued') await jq.requestJobCancellation(f.project.slug, f.row.job_id).catch(() => {})
  }
})
