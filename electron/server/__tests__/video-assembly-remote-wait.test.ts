import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { before, describe, test } from 'node:test'
import type { FinalRenderIntentStagedReceiptV2, Job } from '../models/types.js'
import { writeV2PrivateSnapshot } from './fixtures/final-render-v2-snapshot.js'

let dataRoot = ''
let queue: typeof import('../services/job-queue.js')
let identity = 100

/** A real intent_staged receipt with its private snapshot on disk (retired V1 receipts are never accepted). */
const receipt = (value: Job): Promise<FinalRenderIntentStagedReceiptV2> => writeV2PrivateSnapshot(dataRoot, value, ++identity)

function job(slug: string, id: string): Job {
  return {
    job_id: id, project_slug: slug, type: 'video_assembly', episode_id: 'EP1', title: 'Video', status: 'running',
    created_at: '2026-10-15T00:00:00.000Z', started_at: '2026-10-15T00:00:00.000Z', finished_at: null,
    error: null, output_lines: [], params: {
      voice: 'Sophea', audio: { voice: 'Sophea', pauses: [0.8, 1.2] }, preset: { id: 'cinematic' },
      assets: [{ id: 'scene-a', path: 'accepted/a.png' }, { id: 'scene-b', path: 'accepted/b.png' }],
      pipeline_chain: [{ type: 'metadata', params: { model: 'accepted-model' } }],
    },
  }
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let turn = 0; turn < 500; turn++) {
    if (check()) return
    await new Promise<void>(resolve => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'run through scripts/testing/run-backend-tests.mjs so the data root is isolated')
  dataRoot = await fs.mkdtemp(path.join(harnessRoot, 'video-assembly-remote-wait-'))
  process.env.STORY_STUDIO_DATA_DIR = dataRoot
  await fs.mkdir(path.join(dataRoot, 'projects'), { recursive: true })
  queue = await import('../services/job-queue.js')
})

describe('video assembly remote-wait canonical transition', () => {
  // A remote-wait receipt freezes job.result, so the facts the imported render's finish tail needs must
  // be on disk before either composition can stage it (end to end: final-render-import.test.ts).
  test('generateVideo saves its finish facts durably before either composition can stage', async () => {
    const source = await fs.readFile(new URL('../generators/video.ts', import.meta.url), 'utf8')
    const start = source.indexOf('export async function generateVideo(')
    const generate = source.slice(start, source.indexOf('\n}\n', start))
    const facts = generate.indexOf('final_render_finish: {')
    const saved = generate.indexOf('await checkpointJobState(job)', facts)
    const compositions = [...generate.matchAll(/await runFinalComposition\(/g)].map(match => match.index!)
    assert.ok(facts > 0, 'finish facts are recorded on job.result')
    assert.equal(compositions.length, 2)
    assert.ok(saved > facts && compositions.every(index => index > saved), 'saved before both compositions')
    assert.match(generate.slice(facts, saved), /code, visual_source: [^\n]+, image_pool: /)
  })

  // The real generateVideo with system ffmpeg, on a tiny compilation-layout episode (the layout with no
  // checkpoint); only the composition itself is stood in for, and it reads the saved row as it starts.
  test('the real generateVideo has its finish facts and work folder on disk when the composition starts', async t => {
    const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
    const video = await import('../generators/video.js')
    const { isOwnedVideoAssemblyWorkDir } = await import('../lib/video-assembly-checkpoint.js')
    const slug = `fleet-finish-${process.pid}`
    const projectDir = path.join(dataRoot, 'projects', slug)
    const episodeDir = path.join(projectDir, 'episodes', 'Season 001', 'EP0001 - Fleet')
    await fs.mkdir(path.join(episodeDir, 'scene_images'), { recursive: true })
    await fs.mkdir(path.join(episodeDir, 'EP0001 - 08 Audio Merge Output'), { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug, name: slug, episode_prefix: 'EP', season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    }))
    await fs.writeFile(path.join(projectDir, 'config.json'), JSON.stringify({}))
    await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
      ideas: [{ id: `${slug}-idea`, title: 'Fleet', status: 'accepted', episode_code: 'EP0001' }],
      next_episode_number: 2, recycled_numbers: [],
    }))
    for (const id of ['s1', 's2']) {
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36', '-frames:v', '1',
        path.join(episodeDir, 'scene_images', `${id}.png`)])
    }
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=8000', '-t', '2',
      '-codec:a', 'libmp3lame', '-q:a', '9', path.join(episodeDir, 'EP0001 - 08 Audio Merge Output', 'EP0001_merged_audio.mp3')])
    await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
      schema_version: 1, generated_at: new Date().toISOString(), research_used: false,
      opening_mode: 'from-start', total_duration_sec: 2,
      scenes: [
        { id: 's1', scene_index: 1, start_sec: 0, end_sec: 1, transcript_segment: 'one', visual_prompt: 'one', approved: true },
        { id: 's2', scene_index: 2, start_sec: 1, end_sec: 2, transcript_segment: 'two', visual_prompt: 'two', approved: true },
      ],
    }))
    const render: Job = {
      ...job(slug, 'fleet-finish'), episode_id: 'EP0001',
      params: {
        video_layout: 'compilation', resolution: '720p', quality: 'low', format: 'mp4',
        background_plate: { source_path: path.join(episodeDir, 'scene_images', 's1.png') },
        chapter_durations: [2], audio_gap: 0, subtitles: { enabled: false },
      },
    }
    const jobsPath = path.join(projectDir, 'jobs.json')
    await fs.writeFile(jobsPath, JSON.stringify({ jobs: [render] }))
    queue._forgetProjectPersistenceForTesting(slug)

    let savedAtComposition: Job | undefined
    let compositionCode = ''
    t.after(video._setFinalCompositionHookForTesting(async opts => {
      compositionCode = opts.code ?? ''
      savedAtComposition = (JSON.parse(await fs.readFile(jobsPath, 'utf8')).jobs as Job[])
        .find(row => row.job_id === render.job_id)
      return { kind: 'video-assembly-remote-wait' }
    }))
    assert.deepEqual(await video.generateVideo(render), { kind: 'video-assembly-remote-wait' })

    assert.equal(compositionCode, 'EP0001', 'the composition was reached')
    const facts = savedAtComposition?.result?.final_render_finish
    assert.deepEqual({ ...facts, work_dir: undefined },
      { code: 'EP0001', visual_source: 'scene_plan', image_pool: null, work_dir: undefined })
    assert.equal(await isOwnedVideoAssemblyWorkDir(slug, 'EP0001', facts.work_dir), true,
      'the kept work folder is saved, and is this episode\'s own')
    assert.ok(render.output_lines.some(line => /Remote intent staged — preserved temp files at/.test(line)))
  })

  test('commits revision one only after real disk readback and preserves accepted params', async () => {
    const slug = `commit-${process.pid}`
    const id = 'remote-wait-commit'
    const projectDir = path.join(dataRoot, 'projects', slug)
    await fs.mkdir(projectDir, { recursive: true })
    const original = job(slug, id)
    await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [original] }))
    queue._forgetProjectPersistenceForTesting(slug)

    const staged = await receipt(original)
    const [first, second] = await Promise.all([
      queue.commitFinalRenderRemoteWaitReceipt(original, staged),
      queue.commitFinalRenderRemoteWaitReceipt(original, staged),
    ])
    assert.equal(first.kind, 'committed')
    assert.deepEqual(second.receipt, first.receipt)
    const disk = JSON.parse(await fs.readFile(path.join(projectDir, 'jobs.json'), 'utf8')).jobs[0]
    assert.deepEqual(disk.final_render_remote_wait, staged)
    assert.deepEqual(disk.params, original.params)
  })

  test('retains an exact failed transition for retry and cancellation reuses its first instant', async () => {
    const slug = `retry-${process.pid}`
    const id = 'remote-wait-retry'
    const projectDir = path.join(dataRoot, 'projects', slug)
    await fs.mkdir(projectDir, { recursive: true })
    const original = job(slug, id)
    await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [original] }))
    queue._forgetProjectPersistenceForTesting(slug)
    const staged = await receipt(original)
    let fail = true
    const restore = queue._setJobFileLockProbeForTesting(operation => {
      if (operation === 'persist' && fail) { fail = false; throw new Error('injected write failure') }
    })
    await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(original, staged), /injected write failure/)
    assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(id), true)
    restore()
    await queue.writeAuthoritativeJob({ ...original, status: 'done', params: { voice: 'changed' } })
    const beforeRetry = JSON.parse(await fs.readFile(path.join(projectDir, 'jobs.json'), 'utf8')).jobs[0]
    assert.deepEqual(beforeRetry.final_render_remote_wait, staged)
    assert.equal(beforeRetry.status, 'running')
    assert.deepEqual(beforeRetry.params, original.params)
    await queue.commitFinalRenderRemoteWaitReceipt(original, staged)
    assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(id), false)

    let cancelFail = true
    const restoreCancel = queue._setJobFileLockProbeForTesting(operation => {
      if (operation === 'persist' && cancelFail) { cancelFail = false; throw new Error('injected cancel write failure') }
    })
    await assert.rejects(queue.requestFinalRenderRemoteWaitCancellation(slug, id), /injected cancel write failure/)
    restoreCancel()
    const first = await queue.requestFinalRenderRemoteWaitCancellation(slug, id)
    const second = await queue.requestFinalRenderRemoteWaitCancellation(slug, id)
    assert.equal(first.final_render_remote_wait?.revision, 2)
    assert.equal(second.final_render_remote_wait?.cancel_requested_at, first.final_render_remote_wait?.cancel_requested_at)
    await queue.writeAuthoritativeJob({
      ...original,
      status: 'done',
      finished_at: '2026-10-15T00:10:00.000Z',
      params: { voice: 'changed' },
      result: { complete: true },
      final_render_remote_wait: staged,
    })
    const disk = JSON.parse(await fs.readFile(path.join(projectDir, 'jobs.json'), 'utf8')).jobs[0]
    assert.deepEqual(disk.final_render_remote_wait, second.final_render_remote_wait)
    assert.equal(disk.status, 'running')
    assert.equal(disk.finished_at, null)
    assert.deepEqual(disk.params, original.params)
    assert.equal(disk.result, undefined)
  })

  test('parks after every executor return and releases the local video lane without chaining', async () => {
    const slug = `lane-${process.pid}`
    await fs.mkdir(path.join(dataRoot, 'projects', slug), { recursive: true })
    const calls: string[] = []
    let parked!: () => void
    const bothParked = new Promise<void>(resolve => { parked = resolve })
    const restore = queue._setExecutorForTesting('video_assembly', async current => {
      await queue.commitFinalRenderRemoteWaitReceipt(current, await receipt(current))
      calls.push(current.job_id)
      if (calls.length === 2) parked()
      return calls.length === 1 ? undefined : { kind: 'video-assembly-remote-wait' }
    })
    const first = queue.enqueuePreparedForTest({
      project_slug: slug, episode_id: 'EP1', type: 'video_assembly', title: 'First',
      params: { pipeline_chain: [{ type: 'metadata', params: { model: 'accepted-model' } }] },
    })
    const second = queue.enqueuePreparedForTest({
      project_slug: slug, episode_id: 'EP2', type: 'video_assembly', title: 'Second', params: {},
    })
    await bothParked
    for (let turn = 0; turn < 20 && (queue._isJobWorkerActiveForTesting(first.job_id)
      || queue._isJobWorkerActiveForTesting(second.job_id)); turn++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    restore()

    assert.deepEqual(calls, [first.job_id, second.job_id])
    assert.equal(queue.getJob(first.job_id)?.status, 'running')
    assert.equal(queue.getJob(second.job_id)?.status, 'running')
    assert.equal(queue._isJobWorkerActiveForTesting(first.job_id), false)
    assert.equal(queue._isJobWorkerActiveForTesting(second.job_id), false)
    const updateBlockers = await queue.runningJobsThatWouldNotResume()
    assert.equal(updateBlockers.some(candidate => candidate.job_id === first.job_id || candidate.job_id === second.job_id), false)
    assert.equal((await queue.getJobs(slug)).length, 2, 'the held Pipeline head must not chain another job')
  })

  test('an invalid executor receipt and an already-marked disk row remain recovery-held', async () => {
    const slug = `invalid-${process.pid}`
    const projectDir = path.join(dataRoot, 'projects', slug)
    await fs.mkdir(projectDir, { recursive: true })
    let attempts = 0
    const restore = queue._setExecutorForTesting('video_assembly', async current => {
      attempts++
      await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(current, {
        ...await receipt(current), phase: 'wrong' as 'intent_staged',
      }), /valid initial commitment/i)
    })
    const queued = queue.enqueuePreparedForTest({
      project_slug: slug, episode_id: 'EP1', type: 'video_assembly', title: 'Invalid', params: { auto_retry: false },
    })
    await waitFor(() => !queue._isJobWorkerActiveForTesting(queued.job_id), 'invalid receipt worker did not settle')
    restore()
    assert.equal(attempts, 1)
    assert.equal(queue.getJob(queued.job_id)?.status, 'running')
    assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(queued.job_id), true)

    await queue._waitForJobPersistenceForTesting()
    const staleSlug = `already-marked-${process.pid}`
    const staleProjectDir = path.join(dataRoot, 'projects', staleSlug)
    await fs.mkdir(staleProjectDir, { recursive: true })
    const staleId = 'already-marked-stale-caller'
    const stale = job(staleSlug, staleId)
    const accepted = await receipt(stale)
    await fs.writeFile(path.join(staleProjectDir, 'jobs.json'), JSON.stringify({
      jobs: [{ ...stale, final_render_remote_wait: accepted }],
    }))
    queue._forgetProjectPersistenceForTesting(staleSlug)
    await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(stale, accepted), /lineage already exists/i)
    assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(staleId), true)
    const disk = JSON.parse(await fs.readFile(path.join(staleProjectDir, 'jobs.json'), 'utf8')).jobs[0]
    assert.deepEqual(disk.final_render_remote_wait, accepted)
  })

  test('failed cancellation stays visibly held and simultaneous retries reuse one revision-two instant', async () => {
    const slug = `cancel-race-${process.pid}`
    await fs.mkdir(path.join(dataRoot, 'projects', slug), { recursive: true })
    let parked!: () => void
    const didPark = new Promise<void>(resolve => { parked = resolve })
    const restoreExecutor = queue._setExecutorForTesting('video_assembly', async current => {
      await queue.commitFinalRenderRemoteWaitReceipt(current, await receipt(current))
      parked()
      return { kind: 'video-assembly-remote-wait' }
    })
    const queued = queue.enqueuePreparedForTest({
      project_slug: slug, episode_id: 'EP1', type: 'video_assembly', title: 'Cancel race', params: {},
    })
    await didPark
    await waitFor(() => !queue._isJobWorkerActiveForTesting(queued.job_id), 'parked worker did not release')
    restoreExecutor()
    await queue._waitForJobPersistenceForTesting()

    let fail = true
    const restoreProbe = queue._setJobFileLockProbeForTesting(operation => {
      if (operation === 'persist' && fail) { fail = false; throw new Error('injected cancel failure') }
    })
    await assert.rejects(queue.requestFinalRenderRemoteWaitCancellation(slug, queued.job_id), /injected cancel failure/)
    restoreProbe()
    const held = queue.getPublicJob(queued.job_id)
    assert.equal(held?.final_render_wait?.state, 'recovery_hold')
    assert.ok(held?.controls)
    assert.deepEqual(held.controls.map(control => [control.action, control.enabled]), [['return-later', false]])

    const [first, second] = await Promise.all([
      queue.requestFinalRenderRemoteWaitCancellation(slug, queued.job_id),
      queue.requestFinalRenderRemoteWaitCancellation(slug, queued.job_id),
    ])
    assert.equal(first.final_render_remote_wait?.revision, 2)
    assert.equal(second.final_render_remote_wait?.revision, 2)
    assert.equal(first.final_render_remote_wait?.cancel_requested_at, second.final_render_remote_wait?.cancel_requested_at)
  })

  test('a pending remote transition does not starve unrelated canonical writer waiters', async () => {
    const slug = `writer-${process.pid}`
    const id = 'pending-transition'
    const unrelatedId = 'unrelated-job'
    const projectDir = path.join(dataRoot, 'projects', slug)
    await fs.mkdir(projectDir, { recursive: true })
    const original = job(slug, id)
    const unrelated = { ...job(slug, unrelatedId), type: 'audio_merge' as const }
    await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [original, unrelated] }))
    queue._forgetProjectPersistenceForTesting(slug)
    const staged = await receipt(original)
    let fail = true
    const restore = queue._setJobFileLockProbeForTesting(operation => {
      if (operation === 'persist' && fail) { fail = false; throw new Error('injected transition failure') }
    })
    await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(original, staged), /injected transition failure/)
    restore()

    const updated = await queue.mutateAuthoritativeJob(slug, unrelatedId, current => ({
      ...current, output_lines: [...current.output_lines, 'unrelated progress'],
    }))
    assert.deepEqual(updated?.output_lines, ['unrelated progress'])
    await queue._waitForJobPersistenceForTesting()
    const disk = JSON.parse(await fs.readFile(path.join(projectDir, 'jobs.json'), 'utf8')).jobs
    assert.deepEqual(disk.find((candidate: Job) => candidate.job_id === id).final_render_remote_wait, staged)
    assert.deepEqual(disk.find((candidate: Job) => candidate.job_id === unrelatedId).output_lines, ['unrelated progress'])
    assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(id), true)
  })

  test('an unaccepted proposal cannot replace existing lineage during an overlapping ordinary write', async () => {
    const slug = `preflight-overlap-${process.pid}`
    const id = 'preflight-overlap'
    const projectDir = path.join(dataRoot, 'projects', slug)
    await fs.mkdir(projectDir, { recursive: true })
    const stale = job(slug, id)
    const acceptedA = await receipt(stale)
    const proposedB = await receipt(stale)
    await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({
      jobs: [{ ...stale, final_render_remote_wait: acceptedA }],
    }))
    queue._forgetProjectPersistenceForTesting(slug)

    let releaseInspect!: () => void
    const inspectRelease = new Promise<void>(resolve => { releaseInspect = resolve })
    let inspectEntered!: () => void
    const didEnterInspect = new Promise<void>(resolve => { inspectEntered = resolve })
    const restore = queue._setJobFileLockProbeForTesting(async operation => {
      if (operation === 'inspect') {
        inspectEntered()
        await inspectRelease
      }
    })
    const blocker = queue.inspectAuthoritativeJob(slug, id, () => true)
    await didEnterInspect
    const rejected = queue.commitFinalRenderRemoteWaitReceipt(stale, proposedB)
    await new Promise<void>(resolve => setImmediate(resolve))
    const ordinary = queue.writeAuthoritativeJob({ ...stale, params: { voice: 'ordinary-update' } })
    releaseInspect()
    await blocker
    await assert.rejects(rejected, /lineage already exists/i)
    await ordinary
    restore()

    const firstDisk = JSON.parse(await fs.readFile(path.join(projectDir, 'jobs.json'), 'utf8')).jobs[0]
    assert.deepEqual(firstDisk.final_render_remote_wait, acceptedA)
    await queue.writeAuthoritativeJob({ ...stale, output_lines: ['later ordinary update'] })
    const secondDisk = JSON.parse(await fs.readFile(path.join(projectDir, 'jobs.json'), 'utf8')).jobs[0]
    assert.deepEqual(secondDisk.final_render_remote_wait, acceptedA)
  })

  test('failed initial preflight never becomes retry authority for a missing or non-running row', async () => {
    const wrongSlug = `preflight-status-${process.pid}`
    const wrongId = 'preflight-wrong-status'
    const wrongDir = path.join(dataRoot, 'projects', wrongSlug)
    await fs.mkdir(wrongDir, { recursive: true })
    const runningCaller = job(wrongSlug, wrongId)
    await fs.writeFile(path.join(wrongDir, 'jobs.json'), JSON.stringify({
      jobs: [{ ...runningCaller, status: 'error', error: 'old failure' }],
    }))
    queue._forgetProjectPersistenceForTesting(wrongSlug)
    const wrongReceipt = await receipt(runningCaller)
    await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(runningCaller, wrongReceipt), /canonical running row/i)
    await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(runningCaller, wrongReceipt), /canonical running row/i)
    const wrongDisk = JSON.parse(await fs.readFile(path.join(wrongDir, 'jobs.json'), 'utf8')).jobs[0]
    assert.equal(wrongDisk.status, 'error')
    assert.equal(Object.hasOwn(wrongDisk, 'final_render_remote_wait'), false)

    const missingSlug = `preflight-missing-${process.pid}`
    const missingId = 'preflight-missing'
    const missingDir = path.join(dataRoot, 'projects', missingSlug)
    await fs.mkdir(missingDir, { recursive: true })
    await fs.writeFile(path.join(missingDir, 'jobs.json'), JSON.stringify({ jobs: [] }))
    queue._forgetProjectPersistenceForTesting(missingSlug)
    const missingCaller = job(missingSlug, missingId)
    const missingReceipt = await receipt(missingCaller)
    await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(missingCaller, missingReceipt), /canonical running row/i)
    await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(missingCaller, missingReceipt), /canonical running row/i)
  })

  test('a preflight read failure retains no cached proposal and retries through current disk truth', async () => {
    const slug = `preflight-read-${process.pid}`
    const id = 'preflight-read-failure'
    const projectDir = path.join(dataRoot, 'projects', slug)
    await fs.mkdir(projectDir, { recursive: true })
    const original = job(slug, id)
    const firstProposal = await receipt(original)
    const recoveredProposal = await receipt(original)
    await fs.writeFile(path.join(projectDir, 'jobs.json'), '{malformed')
    queue._forgetProjectPersistenceForTesting(slug)
    await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(original, firstProposal), SyntaxError)
    await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [original] }))
    const recovered = await queue.commitFinalRenderRemoteWaitReceipt(original, recoveredProposal)
    assert.deepEqual(recovered.receipt, recoveredProposal)
    const disk = JSON.parse(await fs.readFile(path.join(projectDir, 'jobs.json'), 'utf8')).jobs[0]
    assert.deepEqual(disk.final_render_remote_wait, recoveredProposal)
  })

  test('syntax-only in-memory receipts return as recovery holds while exact committed receipts remain durable waits', async () => {
    const slug = `memory-only-${process.pid}`
    await fs.mkdir(path.join(dataRoot, 'projects', slug), { recursive: true })
    const calls: string[] = []
    let allReturned!: () => void
    const didReturn = new Promise<void>(resolve => { allReturned = resolve })
    const restore = queue._setExecutorForTesting('video_assembly', async current => {
      calls.push(current.job_id)
      if (current.episode_id === 'EP3') {
        await queue.commitFinalRenderRemoteWaitReceipt(current, await receipt(current))
      } else {
        current.final_render_remote_wait = await receipt(current)
      }
      if (calls.length === 3) allReturned()
      return current.episode_id === 'EP1' ? { kind: 'video-assembly-remote-wait' } : undefined
    })
    const explicit = queue.enqueuePreparedForTest({
      project_slug: slug, episode_id: 'EP1', type: 'video_assembly', title: 'Memory explicit', params: {},
    })
    const implicit = queue.enqueuePreparedForTest({
      project_slug: slug, episode_id: 'EP2', type: 'video_assembly', title: 'Memory void', params: {},
    })
    const committed = queue.enqueuePreparedForTest({
      project_slug: slug, episode_id: 'EP3', type: 'video_assembly', title: 'Committed void', params: {},
    })
    await didReturn
    await waitFor(() => [explicit, implicit, committed].every(candidate => (
      !queue._isJobWorkerActiveForTesting(candidate.job_id)
    )), 'memory-only workers did not release')
    restore()
    await queue._waitForJobPersistenceForTesting()

    for (const candidate of [explicit, implicit]) {
      const publicJob = queue.getPublicJob(candidate.job_id)
      assert.equal(publicJob?.status, 'running')
      assert.equal(publicJob?.final_render_wait?.state, 'recovery_hold')
      assert.ok(publicJob?.controls)
      assert.deepEqual(publicJob.controls.map(control => [control.action, control.enabled]), [['return-later', false]])
      assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(candidate.job_id), true)
      const disk = await queue.loadAuthoritativeJob(slug, candidate.job_id)
      assert.equal(Object.hasOwn(disk || {}, 'final_render_remote_wait'), false)
    }
    const durable = queue.getPublicJob(committed.job_id)
    assert.equal(durable?.final_render_wait?.state, 'intent_staged')
    assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(committed.job_id), false)
    assert.equal((await queue.runningJobsThatWouldNotResume()).some(candidate => (
      candidate.job_id === explicit.job_id || candidate.job_id === implicit.job_id
    )), true)
    assert.equal((await queue.getJobs(slug)).length, 3)
  })
})
