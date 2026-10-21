/**
 * Pipeline continuation ownership at the queue lifecycle boundary.
 *
 * The production regression was outline_only completing successfully, then
 * trying to admit its own expand_chapters continuation while the outline was
 * still a running/active chapter writer. These tests keep the queue, admission
 * guards, persistence writer and lane accounting real; only paid executors are
 * replaced with audited-success fakes.
 */
import { after, before, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job, JobType } from '../models/types.js'
import { installTestSafeStorage, setTestSafeStorageAvailable } from './safe-storage-test-double.js'
import { waitFor } from './_timing.js'
import '../../../scripts/testing/loopback-supertest.mjs'

installTestSafeStorage()

let tempDir = ''
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let wasQueuePaused = false
let previousLlmConcurrency = 50
let previousAudioConcurrency = 1
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

async function waitForPhysicalSettlement(projectSlug: string, label: string): Promise<void> {
  await waitFor(async () => {
    const jobs = await jq.getJobs(projectSlug)
    return jobs.every(job => (
      !jq._isJobWorkerActiveForTesting(job.job_id)
      && job.status !== 'queued'
    ))
  }, { label })
  await jq._waitForJobPersistenceForTesting()
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'run through scripts/testing/run-backend-tests.mjs so the retained owner-only root is isolated')
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    assert.equal(path.resolve(process.env[key] || ''), path.resolve(harnessRoot), `${key} must stay bound to the retained harness root`)
  }
  tempDir = await fs.mkdtemp(path.join(harnessRoot, 'pipeline-handoff-lifecycle-retained-'))
  await fs.chmod(tempDir, 0o700)
  process.env.STORY_STUDIO_DATA_DIR = tempDir
  setTestSafeStorageAvailable(true)
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  wasQueuePaused = jq.isQueuePaused()
  previousLlmConcurrency = jq.getLlmConcurrency()
  previousAudioConcurrency = jq.getAudioEpisodeConcurrency()
  await jq.setQueuePaused(false)
})

after(async () => {
  try {
    if (!jq) return
    await jq.setQueuePaused(false)
    for (const projectSlug of fixtureProjects) {
      await waitForPhysicalSettlement(projectSlug, `${projectSlug} physical workers to settle before environment restore`)
    }
    await jq._waitForJobPersistenceForTesting()
    jq.setLlmConcurrency(previousLlmConcurrency)
    jq.setAudioEpisodeConcurrency(previousAudioConcurrency)
    await jq.setQueuePaused(wasQueuePaused)
    await jq._waitForJobPersistenceForTesting()
  } finally {
    setTestSafeStorageAvailable(true)
    restoreEnvironment()
  }
})

function auditedSuccess(job: Job): void {
  job.result = { ...(job.result || {}), complete: true }
}

async function drainPendingForTesting(parentJobId: string): Promise<void> {
  const drain = (jq as typeof jq & {
    _drainPendingPipelineHandoffForTesting?: (jobId: string) => Promise<void>
  })._drainPendingPipelineHandoffForTesting
  assert.ok(drain, 'the focused test seam must call the same private authoritative drain used by boot/finally')
  await drain(parentJobId)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function retainedFixture(t: TestContext, name: string) {
  const project = await pm.createProject({ name })
  fixtureProjects.add(project.slug)
  const restorers: Array<() => void> = []
  const releases: Array<() => void | Promise<void>> = []
  const settle = async (): Promise<void> => {
    await waitForPhysicalSettlement(project.slug, `${name} physical workers and queued lanes to settle`)
  }
  t.after(async () => {
    for (const release of releases.splice(0)) await release()
    await settle()
    for (const restore of restorers.reverse()) restore()
  })
  return {
    project,
    settle,
    restoreWith: (restore: () => void) => restorers.push(restore),
    releaseWith: (release: () => void | Promise<void>) => releases.push(release),
  }
}

const WRITING_MODEL = 'pool::writing-haiku-gemini-luna-ordered'
const AUDIO_MODEL = 'studio-hub::mlx-community/VoxCPM2-4bit'
const CONTROLS = { temperature: 0.65, stability: 'captured' }
const VOICE_CASES = [
  ['PR0002', 'cc9a1e74-fadc-4d10-9417-6658eb0f5e9c', 'studio-hub-local::voice-a9aedc5c6bd3'],
  ['PR0003', '6e78a474-fc92-48c8-9454-4da64c989a81', 'studio-hub-local::voice-dcc1cf7ac2cc'],
  ['PR0004', 'f24dc623-d816-4f96-a38d-53893657f3b6', 'studio-hub-local::voice-749af648bb63'],
  ['PR0005', 'dc468713-9645-4431-84d9-70b64ad053f8', 'studio-hub-local::voice-cd07b21a2ccf'],
  ['PR0006', '89348707-cda2-47ec-8da4-b7750cf458c7', 'studio-hub-local::voice-0616aec33b41'],
  ['PR0007', '56a1aa07-6e6a-4d1c-937c-f6f45ad8f2fb', 'studio-hub-local::voice-3b8cffeffd63'],
  ['PR0008', 'b821e334-8d45-4d81-b253-3908842286c4', 'studio-hub-local::voice-1d2f3bc43628'],
  ['PR0009', '51c1023d-6e59-4c4d-9692-bb8d0269d655', 'studio-hub-local::voice-b96e838f75ab'],
  ['PR0010', 'bb7807e6-7657-4364-b7fe-59d9bf3913c1', 'studio-hub-local::voice-af496dcef199'],
  ['PR0011', '96a53a86-5b45-423e-984d-e4fa428d11c8', 'studio-hub-local::voice-be6ab4682e08'],
  ['PR0012', 'bc7c4ae7-e300-4da0-a807-1c6051d20b11', 'studio-hub-local::voice-ba75c0a0aa4f'],
  ['PR0013', 'fa3b4144-cda6-4163-b07e-c0929b993e39', 'studio-hub-local::voice-34e171ca810a'],
  ['PR0014', '9ab36adf-3d9e-4d56-9862-478ae33df768', 'studio-hub-local::voice-71c642135dcf'],
] as const

function nativeChain(episodeId: string, voice: string) {
  return [
    {
      type: 'outline_only',
      title: `Pipeline: Script outline — ${episodeId}`,
      params: {
        episode_id: episodeId,
        model: WRITING_MODEL,
        auto_approve: true,
        pipeline_step: 'script-only',
        pipeline_requires: [],
      },
    },
    {
      type: 'expand_chapters',
      title: `Pipeline: Script chapters — ${episodeId}`,
      params: {
        episode_id: episodeId,
        model: WRITING_MODEL,
        auto_approve: true,
        pipeline_step: 'script-only',
        pipeline_requires: [],
      },
    },
    {
      type: 'audio',
      title: `Pipeline: Audio — ${episodeId}`,
      params: {
        episode_id: episodeId,
        model: AUDIO_MODEL,
        voice,
        speed: 1,
        controls: CONTROLS,
        sections: 'all',
        force: false,
        no_overwrite: false,
        pipeline_step: 'audio',
        pipeline_requires: ['script-only'],
      },
    },
  ]
}

test('native research → outline → expansion → audio starts no child before its parent worker and lane release', async t => {
  const f = await retainedFixture(t, 'Pipeline handoff lifecycle')
  jq.setLlmConcurrency(50)
  jq.setAudioEpisodeConcurrency(50)
  const released = new Set<string>()
  const restoreObserver = jq._observeQueuePumpsForTesting((_type, releasedJobId) => {
    if (releasedJobId) released.add(releasedJobId)
  })
  f.restoreWith(restoreObserver)

  const runs = new Map<string, JobType[]>()
  const predecessor = new Map<string, string>()
  const starts: Array<{
    episode: string
    type: JobType
    predecessorWorkerActive: boolean
    predecessorLaneReleased: boolean
    predecessorPersistedStatus: string | undefined
  }> = []
  const audioParams = new Map<string, Record<string, unknown>>()

  for (const type of ['research_run', 'outline_only', 'expand_chapters', 'audio'] as const) {
    f.restoreWith(jq._setExecutorForTesting(type, async job => {
      const previous = predecessor.get(job.episode_id)
      if (previous) {
        starts.push({
          episode: job.episode_id,
          type,
          predecessorWorkerActive: jq._isJobWorkerActiveForTesting(previous),
          predecessorLaneReleased: released.has(previous),
          predecessorPersistedStatus: (await jq.loadAuthoritativeJob(job.project_slug, previous))?.status,
        })
      }
      predecessor.set(job.episode_id, job.job_id)
      runs.set(job.episode_id, [...(runs.get(job.episode_id) || []), type])
      if (type === 'audio') audioParams.set(job.episode_id, structuredClone(job.params))
      auditedSuccess(job)
    }))
  }

  const roots = []
  for (const [episode, batch, voice] of VOICE_CASES) {
    roots.push(await jq.enqueue({
      project_slug: f.project.slug,
      type: 'research_run',
      episode_id: episode,
      title: `Pipeline: Research — ${episode}`,
      params: {
        episode_id: episode,
        model: 'pool::research-fixture',
        auto_retry: false,
        pipeline_step: 'research',
        pipeline_requires: [],
        pipeline_batch_id: batch,
        pipeline_chain: nativeChain(episode, voice),
      },
    }))
  }
  assert.equal(new Set(roots.map(job => job.episode_id)).size, VOICE_CASES.length,
    'the test submits exactly one root per episode')

  await waitFor(async () => {
    const jobs = await jq.getJobs(f.project.slug)
    return jobs.some(job => job.params?.pipeline_handoff_failed === true)
      || VOICE_CASES.every(([episode]) => jobs.some(job => job.episode_id === episode && job.type === 'audio' && job.status === 'done'))
  }, { label: 'native Pipeline chains to finish or expose a handoff failure' })

  const jobs = await jq.getJobs(f.project.slug)
  const handoffFailures = jobs.filter(job => job.params?.pipeline_handoff_failed === true)
  assert.equal(handoffFailures.length, 0,
    `successful parents must not reject their own continuation: ${handoffFailures.map(job => `${job.episode_id}:${job.error}`).join('; ')}`)

  for (const [episode, batch, voice] of VOICE_CASES) {
    assert.deepEqual(runs.get(episode), ['research_run', 'outline_only', 'expand_chapters', 'audio'])
    assert.equal(jobs.filter(job => job.episode_id === episode && job.type === 'research_run').length, 1)
    assert.equal(jobs.filter(job => job.episode_id === episode && job.type === 'outline_only').length, 1)
    assert.equal(jobs.filter(job => job.episode_id === episode && job.type === 'expand_chapters').length, 1,
      'the queue owns the only expansion admission; the test supplies no second expansion')
    assert.equal(jobs.filter(job => job.episode_id === episode && job.type === 'audio').length, 1)
    const captured = audioParams.get(episode)
    assert.equal(captured?.episode_id, episode)
    assert.equal(captured?.pipeline_batch_id, batch)
    assert.equal(captured?.model, AUDIO_MODEL)
    assert.equal(captured?.voice, voice)
    assert.equal(captured?.speed, 1)
    assert.deepEqual(captured?.controls, CONTROLS)
  }

  assert.equal(starts.length, VOICE_CASES.length * 3)
  assert.ok(starts.every(start => start.predecessorWorkerActive === false), JSON.stringify(starts))
  assert.ok(starts.every(start => start.predecessorLaneReleased === true), JSON.stringify(starts))
  assert.ok(starts.every(start => start.predecessorPersistedStatus === 'done'), JSON.stringify(starts))
})

test('a terminal-visible parent still blocks other chapter writers before destructive callbacks until its worker releases', async t => {
  const f = await retainedFixture(t, 'Pipeline parent writer guard')
  jq.setLlmConcurrency(50)
  const atBoundary = deferred()
  const releaseParent = deferred()
  f.releaseWith(releaseParent.resolve)
  let unrelatedRuns = 0
  let destructiveCallbacks = 0

  f.restoreWith(jq._setExecutorForTesting('outline_only', async job => {
    job.status = 'done'
    job.finished_at = new Date().toISOString()
    atBoundary.resolve()
    await releaseParent.promise
    auditedSuccess(job)
  }))
  f.restoreWith(jq._setExecutorForTesting('expand_chapters', async job => {
    unrelatedRuns += 1
    auditedSuccess(job)
  }))
  f.restoreWith(jq._setExecutorForTesting('chapter-only', async job => auditedSuccess(job)))

  const parent = await jq.enqueue({
    project_slug: f.project.slug,
    type: 'outline_only',
    episode_id: 'HOLD001',
    title: 'held outline',
    params: { model: WRITING_MODEL, auto_retry: false },
  })
  await atBoundary.promise
  assert.equal(jq.getJob(parent.job_id)?.status, 'done')
  assert.equal(jq._isJobWorkerActiveForTesting(parent.job_id), true)
  assert.equal((await jq.loadAuthoritativeJob(f.project.slug, parent.job_id))?.status, 'running',
    'the terminal checkpoint is deliberately still held at the persistence boundary')

  const destructive = async () => { destructiveCallbacks += 1 }
  await assert.rejects(jq.enqueue({
    project_slug: f.project.slug,
    type: 'expand_chapters',
    episode_id: 'HOLD001',
    title: 'manual expansion',
    params: { model: WRITING_MODEL },
  }, {}, destructive), /already queued\/running/i)
  await assert.rejects(jq.enqueue({
    project_slug: f.project.slug,
    type: 'chapter-only',
    episode_id: 'HOLD001',
    title: 'targeted chapter',
    params: { model: WRITING_MODEL, chapter_number: 2 },
    dedupeParams: params => Number(params?.chapter_number) === 2,
  }, {}, destructive), /already queued\/running/i)
  assert.equal(destructiveCallbacks, 0)

  const unrelated = await jq.enqueue({
    project_slug: f.project.slug,
    type: 'expand_chapters',
    episode_id: 'FREE001',
    title: 'unrelated episode expansion',
    params: { model: WRITING_MODEL },
  })
  await waitFor(() => jq.getJob(unrelated.job_id)?.status === 'done', {
    label: 'unrelated episode writer to finish',
  })
  assert.equal(unrelatedRuns, 1)
})

async function persistenceFaultFixture(
  t: TestContext,
  name: string,
  failPersistIndexes: ReadonlySet<number>,
) {
  const f = await retainedFixture(t, name)
  const episode = name.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 18)
  const jobsFile = path.join(tempDir, 'projects', f.project.slug, 'jobs.json')
  let armed = false
  let postAuditPersists = 0
  let parentRuns = 0
  let expansionRuns = 0
  let audioRuns = 0
  f.restoreWith(jq._setJobFileLockProbeForTesting(async (stage, file) => {
    if (stage !== 'persist' || path.resolve(file) !== path.resolve(jobsFile) || !armed) return
    const index = postAuditPersists++
    if (failPersistIndexes.has(index)) throw new Error(`injected handoff persistence fault ${index}`)
  }))
  f.restoreWith(jq._setExecutorForTesting('outline_only', async job => {
    parentRuns += 1
    auditedSuccess(job)
    armed = true
  }))
  f.restoreWith(jq._setExecutorForTesting('expand_chapters', async job => {
    expansionRuns += 1
    auditedSuccess(job)
  }))
  f.restoreWith(jq._setExecutorForTesting('audio', async job => {
    audioRuns += 1
    auditedSuccess(job)
  }))
  const parent = await jq.enqueue({
    project_slug: f.project.slug,
    type: 'outline_only',
    episode_id: episode,
    title: `${name} outline`,
    params: {
      episode_id: episode,
      model: WRITING_MODEL,
      auto_retry: false,
      pipeline_batch_id: `batch-${episode.toLowerCase()}`,
      pipeline_chain: nativeChain(episode, 'studio-hub-local::voice-749af648bb63').slice(1),
    },
  })
  return {
    f,
    parent,
    counts: () => ({ parentRuns, expansionRuns, audioRuns, postAuditPersists }),
  }
}

test('one phase-A marker persistence fault never becomes a failure survivor or second parent run', async t => {
  const fixture = await persistenceFaultFixture(t, 'Phase A Once', new Set([0]))
  await waitFor(async () => {
    const jobs = await jq.getJobs(fixture.f.project.slug)
    return jobs.some(job => job.params?.pipeline_handoff_failed === true)
      || jobs.some(job => job.type === 'audio' && job.status === 'done')
  }, { label: 'phase-A marker persistence recovery' })
  const jobs = await jq.getJobs(fixture.f.project.slug)
  assert.equal(jobs.filter(job => job.params?.pipeline_handoff_failed === true).length, 0)
  assert.equal(fixture.counts().parentRuns, 1)
  assert.equal(fixture.counts().expansionRuns, 1)
  assert.equal(fixture.counts().audioRuns, 1)
})

test('one terminal Done persistence fault heals from the phase-A marker without rerunning paid work', async t => {
  const fixture = await persistenceFaultFixture(t, 'Terminal Once', new Set([1]))
  await waitFor(async () => {
    const jobs = await jq.getJobs(fixture.f.project.slug)
    return jobs.some(job => job.params?.pipeline_handoff_failed === true)
      || jobs.some(job => job.type === 'audio' && job.status === 'done')
  }, { label: 'terminal persistence recovery from the durable phase-A marker' })
  const jobs = await jq.getJobs(fixture.f.project.slug)
  assert.equal(jobs.filter(job => job.params?.pipeline_handoff_failed === true).length, 0)
  assert.equal((await jq.loadAuthoritativeJob(fixture.f.project.slug, fixture.parent.job_id))?.status, 'done')
  assert.equal(fixture.counts().parentRuns, 1)
  assert.equal(fixture.counts().expansionRuns, 1)
  assert.equal(fixture.counts().audioRuns, 1)
})

test('persistent checkpoint refusal holds the completed parent idle and starts no child or survivor', async t => {
  const fixture = await persistenceFaultFixture(
    t,
    'Persistent Refusal',
    new Set(Array.from({ length: 32 }, (_, index) => index)),
  )
  await waitFor(() => !jq._isJobWorkerActiveForTesting(fixture.parent.job_id), {
    label: 'checkpoint-refused parent worker to release physically',
  })
  await jq._waitForJobPersistenceForTesting()
  const jobs = await jq.getJobs(fixture.f.project.slug)
  assert.equal(fixture.counts().parentRuns, 1)
  assert.equal(fixture.counts().expansionRuns, 0)
  assert.equal(fixture.counts().audioRuns, 0)
  assert.equal(jobs.filter(job => job.params?.pipeline_handoff_failed === true).length, 0)
  assert.equal(jq.getJob(fixture.parent.job_id)?.status, 'running')
  assert.equal(jq.getJob(fixture.parent.job_id)?.local_execution_complete, true)
})

test('reopening a checkpointed successful parent terminalizes then drains its private exact continuation once', async t => {
  const f = await retainedFixture(t, 'Pipeline exact edge reopen')
  const childId = 'pipeline-handoff-exact-edge'
  const parentId = 'pipeline-parent-terminal'
  const capturedVoice = 'studio-hub-local::voice-a9aedc5c6bd3'
  const exactParams = {
    episode_id: 'EDGE001',
    pipeline_batch_id: 'batch-edge-exact',
    model: AUDIO_MODEL,
    voice: capturedVoice,
    speed: 1,
    controls: CONTROLS,
    pipeline_chain: [],
  }
  const persistedParent = {
    job_id: parentId,
    project_slug: f.project.slug,
    type: 'expand_chapters',
    episode_id: 'EDGE001',
    title: 'checkpointed expansion',
    status: 'running',
    created_at: '2026-10-15T00:00:00.000Z',
    started_at: '2026-10-15T00:00:01.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    local_execution_complete: true,
    result: { complete: true },
    params: { episode_id: 'EDGE001', pipeline_batch_id: 'batch-edge-exact', pipeline_chain: [] },
    pipeline_handoff: {
      version: 1,
      state: 'pending',
      parent_job_id: parentId,
      child_job_id: childId,
      options: {
        project_slug: f.project.slug,
        type: 'audio',
        episode_id: 'EDGE001',
        title: 'captured audio edge',
        params: exactParams,
      },
      content_pack_provenance: [],
    },
  }
  await fs.writeFile(
    path.join(tempDir, 'projects', f.project.slug, 'jobs.json'),
    JSON.stringify({ jobs: [persistedParent] }),
  )

  const audioStarts: Array<Record<string, unknown>> = []
  const durableParentStatusesAtAudioStart: Array<string | undefined> = []
  let parentReruns = 0
  f.restoreWith(jq._setExecutorForTesting('expand_chapters', async job => {
    parentReruns += 1
    auditedSuccess(job)
  }))
  f.restoreWith(jq._setExecutorForTesting('audio', async job => {
    durableParentStatusesAtAudioStart.push(
      (await jq.loadAuthoritativeJob(f.project.slug, parentId))?.status,
    )
    audioStarts.push(structuredClone(job.params))
    auditedSuccess(job)
  }))

  const full = await jq.getJobs(f.project.slug)
  const stream = await jq.getJobs(f.project.slug, { view: 'stream' })
  const fullParent = full.find(job => job.job_id === parentId)
  const streamParent = stream.find(job => job.job_id === parentId)
  const publicParent = jq.getPublicJob(parentId)
  assert.ok(fullParent)
  assert.ok(streamParent)
  assert.ok(publicParent)
  assert.equal('pipeline_handoff' in (fullParent as Job & Record<string, unknown>), false)
  assert.equal('pipeline_handoff' in (streamParent as Job & Record<string, unknown>), false)
  assert.equal('pipeline_handoff' in (publicParent as Job & Record<string, unknown>), false)

  await waitFor(async () => {
    const jobs = await jq.getJobs(f.project.slug)
    return jobs.some(job => job.job_id === childId && job.status === 'done')
  }, { label: 'saved Pipeline continuation to drain after project reopen' })

  assert.equal(parentReruns, 0, 'the durable post-audit marker terminalizes without rerunning its paid parent')
  assert.equal(audioStarts.length, 1)
  assert.deepEqual(durableParentStatusesAtAudioStart, ['done'])
  assert.deepEqual(audioStarts[0], exactParams)
  const jobs = await jq.getJobs(f.project.slug)
  assert.equal(jobs.filter(job => job.job_id === childId).length, 1)
  const durableParent = await jq.loadAuthoritativeJob(f.project.slug, parentId) as Job & Record<string, any>
  assert.equal(durableParent.status, 'done')
  assert.equal(durableParent.pipeline_handoff?.state, 'dispatched')
  assert.equal(durableParent.pipeline_handoff?.child_job_id, childId)
})

test('a mismatched row under the stable child id is retained and the private edge fails closed once', async t => {
  const f = await retainedFixture(t, 'Pipeline mismatched stable child')
  const parentId = 'pipeline-mismatch-parent'
  const childId = 'pipeline-mismatch-child'
  const expectedVoice = 'studio-hub-local::voice-0616aec33b41'
  const mismatchedVoice = 'studio-hub-local::voice-b96e838f75ab'
  const marker = {
    version: 1,
    state: 'pending',
    parent_job_id: parentId,
    child_job_id: childId,
    options: {
      project_slug: f.project.slug,
      type: 'audio',
      episode_id: 'MISMATCH001',
      title: 'expected exact audio edge',
      params: {
        episode_id: 'MISMATCH001',
        pipeline_batch_id: 'batch-mismatch',
        model: AUDIO_MODEL,
        voice: expectedVoice,
        speed: 1,
        controls: CONTROLS,
        pipeline_chain: [],
      },
    },
    content_pack_provenance: [],
  }
  await fs.writeFile(
    path.join(tempDir, 'projects', f.project.slug, 'jobs.json'),
    JSON.stringify({ jobs: [{
      job_id: parentId,
      project_slug: f.project.slug,
      type: 'expand_chapters',
      episode_id: 'MISMATCH001',
      title: 'completed expansion',
      status: 'done',
      created_at: '2026-10-15T02:00:00.000Z',
      started_at: '2026-10-15T02:00:01.000Z',
      finished_at: '2026-10-15T02:00:02.000Z',
      error: null,
      output_lines: [],
      local_execution_complete: true,
      result: { complete: true },
      params: { episode_id: 'MISMATCH001', pipeline_chain: [] },
      pipeline_handoff: marker,
    }, {
      job_id: childId,
      project_slug: f.project.slug,
      type: 'audio',
      episode_id: 'MISMATCH001',
      title: 'different saved edge',
      status: 'done',
      created_at: '2026-10-15T02:00:03.000Z',
      started_at: '2026-10-15T02:00:04.000Z',
      finished_at: '2026-10-15T02:00:05.000Z',
      error: null,
      output_lines: [],
      local_execution_complete: true,
      result: { complete: true },
      params: { ...marker.options.params, voice: mismatchedVoice },
    }] }),
  )

  let audioRuns = 0
  f.restoreWith(jq._setExecutorForTesting('audio', async job => {
    audioRuns += 1
    auditedSuccess(job)
  }))
  await jq.getJobs(f.project.slug)
  await drainPendingForTesting(parentId)

  assert.equal(audioRuns, 0)
  const durableChild = await jq.loadAuthoritativeJob(f.project.slug, childId)
  assert.equal(durableChild?.title, 'different saved edge')
  assert.equal(durableChild?.params.voice, mismatchedVoice)
  const durableParent = await jq.loadAuthoritativeJob(f.project.slug, parentId) as Job & Record<string, any>
  assert.equal(durableParent.pipeline_handoff?.state, 'failed')
  assert.equal(durableParent.pipeline_handoff?.child_job_id, childId)
  assert.equal((await jq.getJobs(f.project.slug)).filter(job => job.job_id === childId).length, 1)
})

test('parent pause, cancellation, and unsettled provider ownership each block a pending edge', async t => {
  const f = await retainedFixture(t, 'Pipeline parent ownership holds')
  const cases = [
    { id: 'pause', parent: 'hold-pause-parent', child: 'hold-pause-child', extra: { pause_requested: true } },
    {
      id: 'cancel',
      parent: 'hold-cancel-parent',
      child: 'hold-cancel-child',
      extra: {
        remote_cancellations: {
          'chat.response:cancel-owned': {
            operation: 'chat.response',
            provider_job_id: 'cancel-owned',
            status: 'confirmed',
            requested_at: '2026-10-15T03:00:00.000Z',
            updated_at: '2026-10-15T03:00:01.000Z',
          },
        },
      },
    },
    {
      id: 'provider',
      parent: 'hold-provider-parent',
      child: 'hold-provider-child',
      extra: {
        genstudio_jobs: [{
          id: 'provider-still-running',
          operation: 'chat.response',
          state: 'running',
          updated_at: '2026-10-15T03:00:01.000Z',
        }],
      },
    },
  ] as const
  const rows = cases.map((scenario, index) => ({
    job_id: scenario.parent,
    project_slug: f.project.slug,
    type: 'expand_chapters',
    episode_id: `HOLD${index + 1}`,
    title: `${scenario.id} owned parent`,
    status: 'done',
    created_at: `2026-10-15T03:00:0${index}.000Z`,
    started_at: `2026-10-15T03:01:0${index}.000Z`,
    finished_at: `2026-10-15T03:02:0${index}.000Z`,
    error: null,
    output_lines: [],
    local_execution_complete: true,
    result: { complete: true },
    params: { episode_id: `HOLD${index + 1}`, pipeline_chain: [] },
    pipeline_handoff: {
      version: 1,
      state: 'pending',
      parent_job_id: scenario.parent,
      child_job_id: scenario.child,
      options: {
        project_slug: f.project.slug,
        type: 'audio',
        episode_id: `HOLD${index + 1}`,
        title: `${scenario.id} held audio`,
        params: {
          episode_id: `HOLD${index + 1}`,
          model: AUDIO_MODEL,
          voice: `studio-hub-local::voice-hold-${scenario.id}`,
          pipeline_chain: [],
        },
      },
      content_pack_provenance: [],
    },
    ...scenario.extra,
  }))
  await fs.writeFile(
    path.join(tempDir, 'projects', f.project.slug, 'jobs.json'),
    JSON.stringify({ jobs: rows }),
  )
  let audioRuns = 0
  f.restoreWith(jq._setExecutorForTesting('audio', async job => {
    audioRuns += 1
    auditedSuccess(job)
  }))
  await jq.getJobs(f.project.slug)
  for (const scenario of cases) await drainPendingForTesting(scenario.parent)

  assert.equal(audioRuns, 0)
  const jobs = await jq.getJobs(f.project.slug)
  for (const scenario of cases) {
    assert.equal(jobs.some(job => job.job_id === scenario.child), false, scenario.id)
    const parent = await jq.loadAuthoritativeJob(f.project.slug, scenario.parent) as Job & Record<string, any>
    assert.equal(parent.pipeline_handoff?.state, 'pending', scenario.id)
  }
})

test('global queue pause admits the durable continuation but the existing Resume pump starts it', async t => {
  const f = await retainedFixture(t, 'Pipeline handoff global pause')
  await jq.setQueuePaused(true)
  f.releaseWith(() => jq.setQueuePaused(false))
  const parentId = 'pipeline-paused-parent'
  const childId = 'pipeline-paused-child'
  const exactParams = {
    episode_id: 'PAUSE001',
    pipeline_batch_id: 'batch-pause-edge',
    model: AUDIO_MODEL,
    voice: 'studio-hub-local::voice-dcc1cf7ac2cc',
    speed: 1,
    controls: CONTROLS,
    pipeline_chain: [],
  }
  await fs.writeFile(
    path.join(tempDir, 'projects', f.project.slug, 'jobs.json'),
    JSON.stringify({ jobs: [{
      job_id: parentId,
      project_slug: f.project.slug,
      type: 'expand_chapters',
      episode_id: 'PAUSE001',
      title: 'completed expansion while queue held',
      status: 'done',
      created_at: '2026-10-15T01:00:00.000Z',
      started_at: '2026-10-15T01:00:01.000Z',
      finished_at: '2026-10-15T01:00:02.000Z',
      error: null,
      output_lines: [],
      local_execution_complete: true,
      result: { complete: true },
      params: { episode_id: 'PAUSE001', pipeline_batch_id: 'batch-pause-edge', pipeline_chain: [] },
      pipeline_handoff: {
        version: 1,
        state: 'pending',
        parent_job_id: parentId,
        child_job_id: childId,
        options: {
          project_slug: f.project.slug,
          type: 'audio',
          episode_id: 'PAUSE001',
          title: 'captured paused audio edge',
          params: exactParams,
        },
        content_pack_provenance: [],
      },
    }] }),
  )

  let audioRuns = 0
  f.restoreWith(jq._setExecutorForTesting('audio', async job => {
    audioRuns += 1
    assert.deepEqual(job.params, exactParams)
    auditedSuccess(job)
  }))

  await jq.getJobs(f.project.slug)
  await waitFor(async () => {
    const jobs = await jq.getJobs(f.project.slug)
    return jobs.some(job => job.job_id === childId && job.status === 'queued')
  }, { label: 'paused queue to retain the durable child without running it' })
  assert.equal(audioRuns, 0)

  await jq.setQueuePaused(false)
  await waitFor(() => jq.getJob(childId)?.status === 'done', {
    label: 'ordinary global Resume pump to start the saved child',
  })
  assert.equal(audioRuns, 1)
  assert.equal((await jq.getJobs(f.project.slug)).filter(job => job.job_id === childId).length, 1)
})

test('provider-settlement completion drains the same exact handoff only after the parent is terminal', async t => {
  const f = await retainedFixture(t, 'Pipeline provider settlement handoff')
  const { getJobCancellationAuditor, registerJobCancellationAuditor } = await import('../services/job-cancellation-auditors.js')
  const previousAuditor = getJobCancellationAuditor('outline_only')
  let audits = 0
  registerJobCancellationAuditor('outline_only', async () => { audits += 1; return 'complete' })
  if (previousAuditor) f.restoreWith(() => registerJobCancellationAuditor('outline_only', previousAuditor))

  const releaseExecutor = deferred()
  f.releaseWith(releaseExecutor.resolve)
  let expansionRuns = 0
  f.restoreWith(jq._setExecutorForTesting('outline_only', async () => releaseExecutor.promise))
  f.restoreWith(jq._setExecutorForTesting('expand_chapters', async job => {
    expansionRuns += 1
    auditedSuccess(job)
  }))

  const parent = await jq.enqueue({
    project_slug: f.project.slug,
    type: 'outline_only',
    episode_id: 'SETTLE001',
    title: 'settled provider outline',
    params: {
      model: WRITING_MODEL,
      auto_retry: false,
      pipeline_batch_id: 'batch-provider-settlement',
      pipeline_chain: [{
        type: 'expand_chapters',
        title: 'settled provider expansion',
        params: { episode_id: 'SETTLE001', model: WRITING_MODEL, auto_approve: true },
      }],
    },
  })
  await waitFor(() => jq.getJob(parent.job_id)?.status === 'running', { label: 'provider parent to start' })
  await jq.recordGenStudioJob(parent.job_id, {
    id: 'settled-outline-provider',
    operation: 'chat.response',
    state: 'accepted',
    dispatch_state: 'pre_dispatch',
    cancellable: true,
    updated_at: new Date().toISOString(),
  })
  await jq.requestJobCancellation(f.project.slug, parent.job_id)
  releaseExecutor.resolve()
  await waitFor(() => jq.getJob(parent.job_id)?.local_execution_complete === true
    && !jq._isJobWorkerActiveForTesting(parent.job_id), { label: 'provider parent worker to release' })
  await jq.recordRemoteCancellation(parent.job_id, 'chat.response', 'settled-outline-provider', {
    status: 'confirmed',
    state: 'succeeded',
  })
  await jq.recordGenStudioJob(parent.job_id, {
    id: 'settled-outline-provider',
    operation: 'chat.response',
    state: 'succeeded',
    updated_at: new Date().toISOString(),
  })
  await waitFor(async () => {
    const jobs = await jq.getJobs(f.project.slug)
    return jobs.some(job => job.params?.pipeline_handoff_failed === true)
      || jobs.some(job => job.type === 'expand_chapters' && job.status === 'done')
  }, { label: 'provider-settled continuation to finish or expose handoff failure' })

  const jobs = await jq.getJobs(f.project.slug)
  assert.equal(jobs.filter(job => job.params?.pipeline_handoff_failed === true).length, 0)
  assert.equal(jq.getJob(parent.job_id)?.status, 'done')
  assert.equal(expansionRuns, 1)
  assert.equal(audits, 1)
})

test('single, scoped, and queue-origin Resume release marker parents without rerunning their paid executors', async t => {
  const f = await retainedFixture(t, 'Pipeline marker Resume paths')
  await jq.setQueuePaused(true)
  f.releaseWith(() => jq.setQueuePaused(false))
  jq.setAudioEpisodeConcurrency(50)

  const provenance = [{
    pack_id: 'pack.pipeline.resume',
    version: '1.0.0',
    archive_sha256: 'resume-pack-sha256',
    item_ids: ['formula.resume'],
  }]
  const cases = [
    { mode: 'single', parent: 'resume-single-parent', child: 'resume-single-child', type: 'outline_only', episode: 'RESUME001', pause_origin: 'manual' },
    { mode: 'scoped', parent: 'resume-scoped-parent', child: 'resume-scoped-child', type: 'expand_chapters', episode: 'RESUME002', pause_origin: 'manual' },
    { mode: 'queue', parent: 'resume-queue-parent', child: 'resume-queue-child', type: 'research_run', episode: 'RESUME003', pause_origin: 'queue' },
  ] as const
  const rows = cases.map((scenario, index) => {
    const exactParams = {
      episode_id: scenario.episode,
      pipeline_batch_id: `batch-${scenario.mode}-resume`,
      model: AUDIO_MODEL,
      voice: `studio-hub-local::voice-${scenario.mode}-resume`,
      speed: 1,
      controls: CONTROLS,
      pipeline_chain: [],
    }
    return {
      job_id: scenario.parent,
      project_slug: f.project.slug,
      type: scenario.type,
      episode_id: scenario.episode,
      title: `${scenario.mode} checkpointed parent`,
      status: 'running',
      created_at: `2026-10-15T05:00:0${index}.000Z`,
      started_at: `2026-10-15T05:01:0${index}.000Z`,
      finished_at: null,
      error: null,
      output_lines: [],
      local_execution_complete: true,
      pause_requested: true,
      pause_origin: scenario.pause_origin,
      result: { complete: true },
      params: {
        episode_id: scenario.episode,
        pipeline_batch_id: `batch-${scenario.mode}-resume`,
        pipeline_chain: [],
      },
      pipeline_handoff: {
        version: 1,
        state: 'pending',
        parent_job_id: scenario.parent,
        child_job_id: scenario.child,
        options: {
          project_slug: f.project.slug,
          type: 'audio',
          episode_id: scenario.episode,
          title: `${scenario.mode} captured audio edge`,
          params: exactParams,
        },
        content_pack_provenance: provenance,
      },
    }
  })
  await fs.writeFile(
    path.join(tempDir, 'projects', f.project.slug, 'jobs.json'),
    JSON.stringify({ jobs: rows }),
  )

  const parentRuns = new Map<string, number>()
  for (const type of ['outline_only', 'expand_chapters', 'research_run'] as const) {
    f.restoreWith(jq._setExecutorForTesting(type, async job => {
      parentRuns.set(job.job_id, (parentRuns.get(job.job_id) || 0) + 1)
      auditedSuccess(job)
    }))
  }
  const childStarts = new Map<string, { params: Record<string, unknown>; provenance: Job['content_pack_provenance'] }>()
  f.restoreWith(jq._setExecutorForTesting('audio', async job => {
    childStarts.set(job.job_id, {
      params: structuredClone(job.params),
      provenance: structuredClone(job.content_pack_provenance),
    })
    auditedSuccess(job)
  }))

  await jq.getJobs(f.project.slug)
  for (const scenario of cases) assert.equal(jq.getJob(scenario.parent)?.status, 'paused', scenario.mode)

  await jq.resumeJob(cases[0].parent)
  await jq.resumePausedJobs({ projectSlugs: [f.project.slug], type: 'expand_chapters' })
  await jq._waitForJobPersistenceForTesting()

  for (const scenario of cases.slice(0, 2)) {
    assert.equal(parentRuns.get(scenario.parent) || 0, 0, scenario.mode)
    assert.equal(jq.getJob(scenario.parent)?.status, 'done', scenario.mode)
    assert.equal(jq.getJob(scenario.child)?.status, 'queued', scenario.mode)
  }
  assert.equal(jq.getJob(cases[2].parent)?.status, 'paused')

  await jq.setQueuePaused(false)
  await waitFor(() => cases.every(scenario => jq.getJob(scenario.child)?.status === 'done'), {
    label: 'all three marker-aware Resume paths to release their exact children',
  })

  for (const scenario of cases) {
    assert.equal(parentRuns.get(scenario.parent) || 0, 0, scenario.mode)
    const expected = rows.find(row => row.job_id === scenario.parent)!.pipeline_handoff
    const child = jq.getJob(scenario.child)
    assert.ok(child, scenario.mode)
    assert.deepEqual(child.params, expected.options.params, scenario.mode)
    assert.deepEqual(child.content_pack_provenance, provenance, scenario.mode)
    assert.deepEqual(childStarts.get(scenario.child), {
      params: expected.options.params,
      provenance,
    }, scenario.mode)
    const durableParent = await jq.loadAuthoritativeJob(f.project.slug, scenario.parent) as Job & Record<string, any>
    assert.equal(durableParent.pipeline_handoff?.state, 'dispatched', scenario.mode)
    assert.equal(durableParent.pipeline_handoff?.child_job_id, scenario.child, scenario.mode)
  }
})

async function assertQueuedStableChildConflictIsHeld(
  t: TestContext,
  storageOrder: 'parent-before-child' | 'child-before-parent',
): Promise<void> {
  const f = await retainedFixture(t, `Pipeline queued child conflict ${storageOrder}`)
  jq.setAudioEpisodeConcurrency(50)
  const parentId = `queued-conflict-parent-${storageOrder}`
  const childId = `queued-conflict-child-${storageOrder}`
  const neighborParentId = `queued-conflict-neighbor-parent-${storageOrder}`
  const neighborChildId = `queued-conflict-neighbor-child-${storageOrder}`
  const expectedProvenance = [{
    pack_id: 'pack.pipeline.expected', version: '1.0.0', archive_sha256: 'expected-sha256', item_ids: ['formula.expected'],
  }]
  const conflictingProvenance = [{
    pack_id: 'pack.pipeline.conflict', version: '9.0.0', archive_sha256: 'conflict-sha256', item_ids: ['formula.conflict'],
  }]
  const expectedParams = {
    episode_id: `CONFLICT-${storageOrder}`,
    pipeline_batch_id: `batch-conflict-${storageOrder}`,
    model: AUDIO_MODEL,
    voice: 'studio-hub-local::voice-expected-stable-child',
    controls: CONTROLS,
    pipeline_chain: [],
  }
  const conflictingParams = {
    ...expectedParams,
    voice: 'studio-hub-local::voice-conflicting-stable-child',
  }
  const conflictParent = {
    job_id: parentId,
    project_slug: f.project.slug,
    type: 'expand_chapters',
    episode_id: expectedParams.episode_id,
    title: 'completed conflict parent',
    status: 'done',
    created_at: '2026-10-15T06:00:00.000Z',
    started_at: '2026-10-15T06:00:01.000Z',
    finished_at: '2026-10-15T06:00:02.000Z',
    error: null,
    output_lines: [],
    local_execution_complete: true,
    result: { complete: true },
    params: { episode_id: expectedParams.episode_id, pipeline_chain: [] },
    pipeline_handoff: {
      version: 1,
      state: 'pending',
      parent_job_id: parentId,
      child_job_id: childId,
      options: {
        project_slug: f.project.slug,
        type: 'audio',
        episode_id: expectedParams.episode_id,
        title: 'expected stable child',
        params: expectedParams,
      },
      content_pack_provenance: expectedProvenance,
    },
  }
  const conflictingChild = {
    job_id: childId,
    project_slug: f.project.slug,
    type: 'audio',
    episode_id: expectedParams.episode_id,
    title: 'retained conflicting stable child',
    status: 'queued',
    created_at: '2026-10-15T06:00:03.000Z',
    started_at: null,
    finished_at: null,
    error: null,
    output_lines: ['This conflicting row must remain exact evidence.'],
    params: conflictingParams,
    content_pack_provenance: conflictingProvenance,
  }
  const neighborParams = {
    episode_id: `NEIGHBOR-${storageOrder}`,
    pipeline_batch_id: `batch-neighbor-${storageOrder}`,
    model: AUDIO_MODEL,
    voice: 'studio-hub-local::voice-valid-neighbor',
    pipeline_chain: [],
  }
  const neighborParent = {
    job_id: neighborParentId,
    project_slug: f.project.slug,
    type: 'expand_chapters',
    episode_id: neighborParams.episode_id,
    title: 'completed neighboring parent',
    status: 'done',
    created_at: '2026-10-15T06:00:04.000Z',
    started_at: '2026-10-15T06:00:05.000Z',
    finished_at: '2026-10-15T06:00:06.000Z',
    error: null,
    output_lines: [],
    local_execution_complete: true,
    result: { complete: true },
    params: { episode_id: neighborParams.episode_id, pipeline_chain: [] },
    pipeline_handoff: {
      version: 1,
      state: 'pending',
      parent_job_id: neighborParentId,
      child_job_id: neighborChildId,
      options: {
        project_slug: f.project.slug,
        type: 'audio',
        episode_id: neighborParams.episode_id,
        title: 'valid neighboring child',
        params: neighborParams,
      },
      content_pack_provenance: [],
    },
  }
  const ordered = storageOrder === 'parent-before-child'
    ? [conflictParent, conflictingChild, neighborParent]
    : [conflictingChild, conflictParent, neighborParent]
  await fs.writeFile(
    path.join(tempDir, 'projects', f.project.slug, 'jobs.json'),
    JSON.stringify({ jobs: ordered }),
  )

  const audioExecutions: string[] = []
  f.restoreWith(jq._setExecutorForTesting('audio', async job => {
    audioExecutions.push(job.job_id)
    auditedSuccess(job)
  }))

  await jq.getJobs(f.project.slug)
  await waitFor(() => jq.getJob(neighborChildId)?.status === 'done', {
    label: `${storageOrder} valid neighboring handoff to finish`,
  })

  assert.deepEqual(audioExecutions, [neighborChildId], `${storageOrder} must not admit the conflicting queued row`)
  const durableConflict = await jq.loadAuthoritativeJob(f.project.slug, childId)
  assert.ok(durableConflict)
  assert.equal(durableConflict.title, conflictingChild.title)
  assert.deepEqual(durableConflict.params, conflictingParams)
  assert.deepEqual(durableConflict.content_pack_provenance, conflictingProvenance)
  assert.ok(durableConflict.output_lines.includes('This conflicting row must remain exact evidence.'))
  assert.ok(durableConflict.status === 'paused' || durableConflict.status === 'error',
    `${storageOrder} conflict must be held durably outside a runnable lane`)
  const durableParent = await jq.loadAuthoritativeJob(f.project.slug, parentId) as Job & Record<string, any>
  assert.equal(durableParent.pipeline_handoff?.state, 'failed')
  assert.equal(durableParent.pipeline_handoff?.child_job_id, childId)
  assert.equal((await jq.getJobs(f.project.slug)).filter(job => job.job_id === childId).length, 1)
}

test('boot holds a queued mismatching stable child when its parent row is stored first and still runs a valid neighbor', async t => {
  await assertQueuedStableChildConflictIsHeld(t, 'parent-before-child')
})

test('boot holds a queued mismatching stable child when its child row is stored first and still runs a valid neighbor', async t => {
  await assertQueuedStableChildConflictIsHeld(t, 'child-before-parent')
})

test('boot keeps unresolved provider ownership on every mismatching stable child before duplicate or writer admission', async t => {
  const f = await retainedFixture(t, 'Pipeline queued provider-owned conflicts')
  jq.setLlmConcurrency(50)
  const cases = [
    { id: 'accepted-parent-first', state: 'accepted', order: 'parent-before-child' },
    { id: 'accepted-child-first', state: 'accepted', order: 'child-before-parent' },
    { id: 'running-parent-first', state: 'running', order: 'parent-before-child' },
    { id: 'unknown-child-first', state: 'unknown', order: 'child-before-parent' },
  ] as const
  const expected = new Map<string, {
    parentId: string
    childId: string
    episode: string
    params: Record<string, unknown>
    provenance: NonNullable<Job['content_pack_provenance']>
    evidence: Array<Record<string, unknown>>
  }>()
  const rows: Array<Record<string, unknown>> = []

  for (const [index, scenario] of cases.entries()) {
    const episode = `OWNED-CONFLICT-${index + 1}`
    const parentId = `provider-conflict-parent-${scenario.id}`
    const childId = `provider-conflict-child-${scenario.id}`
    const expectedParams = {
      episode_id: episode,
      pipeline_batch_id: `batch-provider-conflict-${scenario.id}`,
      model: WRITING_MODEL,
      pipeline_chain: [],
    }
    const conflictingParams = { ...expectedParams, model: `${WRITING_MODEL}::conflicting` }
    const expectedProvenance = [{
      pack_id: 'pack.pipeline.expected-owner',
      version: '1.0.0',
      archive_sha256: `expected-owner-${scenario.id}`,
      item_ids: ['formula.expected-owner'],
    }]
    const conflictingProvenance = [{
      pack_id: 'pack.pipeline.provider-owner',
      version: '2.0.0',
      archive_sha256: `provider-owner-${scenario.id}`,
      item_ids: ['formula.provider-owner'],
    }]
    // The loader's ownership predicate is provider-state generic. This
    // deliberately unregistered operation prevents the fixture from starting
    // reconciliation transport while retaining an exact accepted-work ID.
    const evidence = [{
      id: `provider-owned-${scenario.id}`,
      operation: 'pipeline.lifecycle.test',
      state: scenario.state,
      dispatch_state: 'dispatched',
      cancellable: true,
      updated_at: `2026-10-15T07:00:0${index}.000Z`,
    }]
    const parent = {
      job_id: parentId,
      project_slug: f.project.slug,
      type: 'outline_only',
      episode_id: episode,
      title: `${scenario.id} completed parent`,
      status: 'done',
      created_at: `2026-10-15T07:01:0${index}.000Z`,
      started_at: `2026-10-15T07:02:0${index}.000Z`,
      finished_at: `2026-10-15T07:03:0${index}.000Z`,
      error: null,
      output_lines: [],
      local_execution_complete: true,
      result: { complete: true },
      params: { episode_id: episode, pipeline_chain: [] },
      pipeline_handoff: {
        version: 1,
        state: 'pending',
        parent_job_id: parentId,
        child_job_id: childId,
        options: {
          project_slug: f.project.slug,
          type: 'expand_chapters',
          episode_id: episode,
          title: `${scenario.id} expected child`,
          params: expectedParams,
        },
        content_pack_provenance: expectedProvenance,
      },
    }
    const child = {
      job_id: childId,
      project_slug: f.project.slug,
      type: 'expand_chapters',
      episode_id: episode,
      title: `${scenario.id} retained provider-owned conflict`,
      status: 'queued',
      created_at: `2026-10-15T07:04:0${index}.000Z`,
      started_at: null,
      finished_at: null,
      error: null,
      output_lines: [`Original provider ownership: ${scenario.id}`],
      params: conflictingParams,
      content_pack_provenance: conflictingProvenance,
      genstudio_jobs: evidence,
    }
    rows.push(...(scenario.order === 'parent-before-child' ? [parent, child] : [child, parent]))
    expected.set(scenario.id, {
      parentId,
      childId,
      episode,
      params: conflictingParams,
      provenance: conflictingProvenance,
      evidence,
    })
  }
  await fs.writeFile(
    path.join(tempDir, 'projects', f.project.slug, 'jobs.json'),
    JSON.stringify({ jobs: rows }),
  )

  const conflictExecutions: string[] = []
  f.restoreWith(jq._setExecutorForTesting('expand_chapters', async job => {
    if (job.job_id.startsWith('provider-conflict-child-')) conflictExecutions.push(job.job_id)
    auditedSuccess(job)
  }))
  f.restoreWith(jq._setExecutorForTesting('chapter-only', async job => auditedSuccess(job)))
  await jq.getJobs(f.project.slug)

  const duplicateOwnership = cases.map(scenario => {
    const item = expected.get(scenario.id)!
    return jq.isDuplicate(f.project.slug, item.episode, 'expand_chapters')
  })
  let destructiveCallbacks = 0
  const writerAdmissions: Array<unknown> = []
  for (const [index, scenario] of cases.entries()) {
    const item = expected.get(scenario.id)!
    try {
      writerAdmissions.push(await jq.enqueue({
        project_slug: f.project.slug,
        type: 'chapter-only',
        episode_id: item.episode,
        title: `${scenario.id} competing chapter writer`,
        params: { model: WRITING_MODEL, chapter_number: index + 1 },
        dedupeParams: params => Number(params?.chapter_number) === index + 1,
      }, {}, async () => { destructiveCallbacks += 1 }))
    } catch (error) {
      writerAdmissions.push(error)
    }
  }

  assert.deepEqual(duplicateOwnership, cases.map(() => true),
    'every unresolved conflicting child must retain same-type duplicate ownership')
  assert.equal(destructiveCallbacks, 0,
    'the unresolved owner must refuse a new chapter writer before its callback can mutate inputs')
  assert.ok(writerAdmissions.every(result => result instanceof jq.DuplicateJobError))
  assert.deepEqual(conflictExecutions, [])

  for (const scenario of cases) {
    const item = expected.get(scenario.id)!
    const durableChild = await jq.loadAuthoritativeJob(f.project.slug, item.childId)
    assert.ok(durableChild)
    assert.equal(durableChild.status, 'running', scenario.id)
    assert.equal(durableChild.local_execution_complete, true, scenario.id)
    assert.equal(durableChild.finished_at, null, scenario.id)
    assert.deepEqual(durableChild.params, item.params, scenario.id)
    assert.deepEqual(durableChild.content_pack_provenance, item.provenance, scenario.id)
    assert.deepEqual(durableChild.genstudio_jobs, item.evidence, scenario.id)
    assert.ok(durableChild.output_lines.includes(`Original provider ownership: ${scenario.id}`), scenario.id)
    const durableParent = await jq.loadAuthoritativeJob(f.project.slug, item.parentId) as Job & Record<string, any>
    assert.equal(durableParent.pipeline_handoff?.state, 'failed', scenario.id)
    assert.equal(durableParent.pipeline_handoff?.child_job_id, item.childId, scenario.id)
  }
})

test('provider settlement drains once only after finalizer ownership is released', async t => {
  const f = await retainedFixture(t, 'Pipeline provider finalizer ownership')
  const { getJobCancellationAuditor, registerJobCancellationAuditor } = await import('../services/job-cancellation-auditors.js')
  const previousAuditor = getJobCancellationAuditor('outline_only')
  registerJobCancellationAuditor('outline_only', async () => 'complete')
  if (previousAuditor) f.restoreWith(() => registerJobCancellationAuditor('outline_only', previousAuditor))

  const atReleasedFinalizer = deferred()
  const allowPostReleaseDrain = deferred()
  f.releaseWith(allowPostReleaseDrain.resolve)
  const setReleaseProbe = (jq as typeof jq & {
    _setProviderFinalizerReleaseProbeForTesting?: (
      probe: (jobId: string) => void | Promise<void>,
    ) => () => void
  })._setProviderFinalizerReleaseProbeForTesting
  assert.ok(setReleaseProbe,
    'the focused test seam must hold the real boundary after providerFinalizing ownership is removed and before its one drain')
  let parentId = ''
  f.restoreWith(setReleaseProbe(async releasedJobId => {
    if (releasedJobId !== parentId) return
    atReleasedFinalizer.resolve()
    await allowPostReleaseDrain.promise
  }))

  const releaseExecutor = deferred()
  f.releaseWith(releaseExecutor.resolve)
  let parentRuns = 0
  let expansionRuns = 0
  f.restoreWith(jq._setExecutorForTesting('outline_only', async () => {
    parentRuns += 1
    await releaseExecutor.promise
  }))
  f.restoreWith(jq._setExecutorForTesting('expand_chapters', async job => {
    expansionRuns += 1
    auditedSuccess(job)
  }))

  const parent = await jq.enqueue({
    project_slug: f.project.slug,
    type: 'outline_only',
    episode_id: 'SETTLE-OWNER-001',
    title: 'provider-owned outline',
    params: {
      model: WRITING_MODEL,
      auto_retry: false,
      pipeline_batch_id: 'batch-provider-owner',
      pipeline_chain: [{
        type: 'expand_chapters',
        title: 'post-finalizer expansion',
        params: { episode_id: 'SETTLE-OWNER-001', model: WRITING_MODEL, auto_approve: true },
      }],
    },
  })
  parentId = parent.job_id
  await waitFor(() => jq.getJob(parentId)?.status === 'running', { label: 'provider-owned parent to start' })
  await jq.recordGenStudioJob(parentId, {
    id: 'provider-finalizer-owner',
    operation: 'chat.response',
    state: 'accepted',
    dispatch_state: 'pre_dispatch',
    cancellable: true,
    updated_at: new Date().toISOString(),
  })
  await jq.requestJobCancellation(f.project.slug, parentId)
  releaseExecutor.resolve()
  await waitFor(() => jq.getJob(parentId)?.local_execution_complete === true
    && !jq._isJobWorkerActiveForTesting(parentId), { label: 'provider-owned parent worker to release' })
  await jq.recordRemoteCancellation(parentId, 'chat.response', 'provider-finalizer-owner', {
    status: 'confirmed',
    state: 'succeeded',
  })
  await jq.recordGenStudioJob(parentId, {
    id: 'provider-finalizer-owner',
    operation: 'chat.response',
    state: 'succeeded',
    updated_at: new Date().toISOString(),
  })

  await atReleasedFinalizer.promise
  assert.equal(parentRuns, 1)
  assert.equal(jq.getJob(parentId)?.status, 'done')
  assert.equal(expansionRuns, 0, 'the child must still be absent at the released-owner barrier before the one drain')
  assert.equal((await jq.getJobs(f.project.slug)).some(job => job.type === 'expand_chapters'), false)

  allowPostReleaseDrain.resolve()
  await waitFor(async () => {
    const jobs = await jq.getJobs(f.project.slug)
    return jobs.some(job => job.params?.pipeline_handoff_failed === true)
      || jobs.some(job => job.type === 'expand_chapters' && job.status === 'done')
  }, { label: 'post-finalizer Pipeline continuation to drain once' })

  const jobs = await jq.getJobs(f.project.slug)
  assert.equal(jobs.filter(job => job.params?.pipeline_handoff_failed === true).length, 0)
  assert.equal(jobs.filter(job => job.type === 'expand_chapters').length, 1)
  assert.equal(expansionRuns, 1)
})
