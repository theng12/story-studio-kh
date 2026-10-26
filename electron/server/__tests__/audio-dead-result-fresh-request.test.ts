/**
 * A Gateway result Story can never use must not be collected again (2026-10-09, mini 1.4.262):
 * - EP0045: a Gateway restart left parts held as UNKNOWN_OUTCOME; the owner's "Resolve All Needing
 *   Recovery" closed the holds (HOLD_CLOSED) and every auto-retry collected the same dead jobs.
 * - EP0038: the Gateway stored a 0-byte m4a as `succeeded`; every retry downloaded it again and
 *   FFmpeg failed with "moov atom not found".
 * Free fleet narration asks afresh; paid voices stay manual (services/job-retry-policy.ts).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { generateAudio, resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
const pm = await import('../services/project-manager.js')
const jq = await import('../services/job-queue.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { readManifest } = await import('../services/task-manifest.js')
const { _setJobAutoRetryDelaysForTesting } = await import('../services/job-retry-policy.js')
const { _setGenStudioPollLadderForTesting } = await import('../lib/genstudio-client.js')
const { probeAudioSignature } = await import('../lib/audio-concat.js')

const FLEET = 'studio-hub::tiny-model'
const PAID = 'paid-tiny-model'
const service = await startMockGenStudioService()
await setGenStudioUrl(service.baseUrl)
await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
const model = (id: string) => ({
  id, display_name: id, provider_id: 'p', provider_name: 'Mock provider', description: '',
  credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 40,
  supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
  preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [],
})
service.ttsModels = [model(FLEET), model(PAID)]
clearGenStudioCatalogCache()
jq.registerExecutor('audio', job => generateAudio(job))

// Every case here drives a job into its SECOND attempt on purpose, and free-fleet work waits the
// real 60 s before it. What each test proves is which work that attempt asks for and what it says,
// not how long the customer waited first, so the schedule is compressed to milliseconds. The number
// of attempts and the reasons for them are unchanged (job-retry-policy.ts keeps the list's length).
_setJobAutoRetryDelaysForTesting(5)
// The same for the poll cadence: the mock answers in milliseconds, so every wait between polls is
// one second of nothing. Polling more often shows the same sequence of states and the same requests.
_setGenStudioPollLadderForTesting([10])

test.after(async () => {
  assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true)
  clearGenStudioCatalogCache()
  await service.close()
  await temp.cleanup()
})

const PART2 = 'EP001_Chapter_01_part2.mp3'
let projects = 0
async function episode(modelId: string) {
  service.clearQueuedScenarios('tts')
  const project = await pm.createProject({ name: `Dead result ${++projects}`, episode_prefix: 'EP', episode_digits: 3 })
  const outputRoot = (await pm.getProjectOutputRoot(project.slug))!
  const narrationDir = path.join(outputRoot, 'EP001 - Script')
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(path.join(narrationDir, 'EP001_Script_Narration.md'), [
    '# Narration', '## Chapter 1: One',
    'First sentence is here. Second sentence is here.', 'Third paragraph is here.',
  ].join('\n\n'))
  const narration = await findNarrationFile(project.slug, 'EP001')
  const audioDir = await resolveAudioDir(project.slug, narration, 'EP001')
  const params = { episode_id: 'EP001', model: modelId, voice: 'mock-voice', sections: 'Chapter_01', speed: 1, force: false, no_overwrite: false }
  let run = 0
  /** One run of the generator, as a manual Retry (a new Story job) makes it. */
  const direct = async () => {
    const job: any = {
      job_id: `${project.slug}-${++run}`, project_slug: project.slug, type: 'audio', episode_id: 'EP001', title: 'Narration',
      status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(),
      finished_at: null, error: null, output_lines: [], params: structuredClone(params),
    }
    await generateAudio(job)
    return job
  }
  const enqueue = () => jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'EP001', title: 'Narration', params: structuredClone(params) })
  const settled = async (jobId: string) => {
    await waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || ''), { label: 'audio job to settle', timeoutMs: 30_000 })
    return jq.getJob(jobId)!
  }
  const part2Task = async () => (await readManifest(audioDir)).tasks[PART2]
  return { project, audioDir, direct, enqueue, settled, part2Task }
}

const artifactGets = (jobId: string) => service.requests.filter(r => r.method === 'GET' && r.path === `/v1/jobs/${jobId}/audio`).length
const lines = (job: { output_lines: string[] }) => job.output_lines.join('\n')
const mockId = (n: number) => `mock-tts-${String(n).padStart(3, '0')}`

void test('HOLD_CLOSED after a Gateway restart: the auto-retry asks afresh instead of collecting the dead job (EP0045)', async () => {
  const ep = await episode(FLEET)
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  service.queueScenario('tts', { states: ['accepted', 'failed'], failureCode: 'UNKNOWN_OUTCOME', finalCredits: 0, envelope: { recovery_required: true, recovery_state: 'unknown_outcome' } })
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  const before = service.providerSubmissionCount('tts')
  const heldId = mockId(before + 2)
  // The held job waits out its 5-minute adoption window: move the clock on while it is held.
  const realNow = Date.now
  let skew = 0
  Date.now = () => realNow() + skew
  let closed = false
  const { job_id } = await ep.enqueue()
  try {
    // Not `waitFor`: it budgets by Date.now, which this test moves on until the job settles.
    await new Promise<void>((resolve, reject) => {
      const giveUp = setTimeout(() => { clearInterval(watcher); reject(new Error('audio job did not settle')) }, 120_000)
      const watcher = setInterval(() => {
        const live = jq.getJob(job_id)
        if (['done', 'error', 'cancelled'].includes(live?.status || '')) {
          clearInterval(watcher)
          clearTimeout(giveUp)
          resolve()
        } else if (!closed && live?.output_lines.some(line => line.startsWith('↻ Attempt 1/'))) {
          // The owner presses "Resolve All Needing Recovery" once attempt 1 has given up on the part.
          closed = true
          service.patchJobScenario(heldId, { failureCode: 'HOLD_CLOSED', envelope: { recovery_required: false, recovery_state: null } })
        } else if (!closed && live?.genstudio_jobs?.some(entry => entry.id === heldId && entry.recovery_required === true)) {
          skew += 60_000
        }
      }, 50)
    })
  } finally {
    Date.now = realNow
  }
  const job = jq.getJob(job_id)!
  const text = lines(job)
  assert.equal(job.status, 'done', `${job.error}\n${text}`)
  assert.ok(closed, 'the hold was closed')
  assert.match(text, /Auto-retry attempt 2\/3/)
  assert.doesNotMatch(text, /Auto-retry attempt 3\/3/, 'the second attempt finishes the part')
  assert.match(text, new RegExp(`${PART2}: the earlier result can't be used \\(HOLD_CLOSED\\); asking for it again`))
  assert.equal(service.providerSubmissionCount('tts'), before + 4, 'exactly one fresh request for the closed part')
  const task = await ep.part2Task()
  assert.equal(task?.last_state, 'succeeded')
  assert.notEqual(task?.task_id, heldId)
})

void test('a corrupt download is fetched again, then the part is made afresh (EP0038)', async () => {
  const ep = await episode(FLEET)
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  service.queueScenario('tts', { states: ['accepted', 'succeeded'], audioArtifact: Buffer.alloc(0) })
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  const before = service.providerSubmissionCount('tts')
  const job = await ep.direct()
  const text = lines(job)
  assert.match(text, new RegExp(`${PART2}: the earlier result can't be used \\(unusable audio\\); asking for it again`), text)
  assert.equal(artifactGets(mockId(before + 2)), 2, 'the empty artifact was downloaded twice, no more')
  assert.equal(service.providerSubmissionCount('tts'), before + 4, 'one fresh request for the unusable part')
  assert.match(text, /Joined 3 parts of Chapter 01/)
  assert.match(String(await probeAudioSignature(path.join(ep.audioDir, 'EP001_Chapter_01.mp3'))), /^mp3,/)
})

void test('a valid artifact is used as before: one download each, nothing asked again', async () => {
  const ep = await episode(FLEET)
  for (let i = 0; i < 3; i++) service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  const before = service.providerSubmissionCount('tts')
  const job = await ep.direct()
  assert.equal(service.providerSubmissionCount('tts'), before + 3)
  for (let i = 1; i <= 3; i++) assert.equal(artifactGets(mockId(before + i)), 1)
  assert.doesNotMatch(lines(job), /asking for it again/)
  assert.match(lines(job), /Joined 3 parts of Chapter 01/)
})

void test('paid voices are never regenerated automatically; the owner\'s Retry sends the new request', async () => {
  const ep = await episode(PAID)
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  service.queueScenario('tts', { states: ['accepted', 'succeeded'], audioArtifact: Buffer.from('not audio at all') })
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  const before = service.providerSubmissionCount('tts')
  await assert.rejects(ep.direct(), /1 section\(s\) failed: Chapter 01: The audio from Gateway job mock-tts-\d+ is unusable \(16 bytes with no readable audio\)/)
  assert.equal(service.providerSubmissionCount('tts'), before + 3, 'nothing was bought twice')
  assert.equal(artifactGets(mockId(before + 2)), 2)
  assert.equal((await ep.part2Task())?.last_state, 'artifact_expired')
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  const retry = await ep.direct()
  assert.match(lines(retry), new RegExp(`The earlier request for ${PART2} failed for good; sending a new one`))
  assert.equal(service.providerSubmissionCount('tts'), before + 4)

  // A closed hold on a paid voice: the part fails and nothing new is submitted by itself.
  const paid = await episode(PAID)
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  service.queueScenario('tts', { states: ['accepted', 'failed'], failureCode: 'HOLD_CLOSED', finalCredits: 0 })
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  const start = service.providerSubmissionCount('tts')
  await assert.rejects(paid.direct(), /HOLD_CLOSED/)
  assert.equal(service.providerSubmissionCount('tts'), start + 3)
  assert.equal((await paid.part2Task())?.last_state, 'failed')
})

void test('Audio Repair: a dead saved request is not collected again; free fleet asks afresh, paid stays manual (1.4.269)', async () => {
  const { reconcileAudio } = await import('../services/audio-reconciler.js')
  const { recordTask } = await import('../services/task-manifest.js')
  for (const modelId of [FLEET, PAID]) {
    const ep = await episode(modelId)
    // A run that left part 2 missing (no automatic retry here, to keep the test short).
    service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
    service.queueScenario('tts', { states: ['accepted', 'failed'], failureCode: 'provider_error', finalCredits: 0 })
    service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
    const made = await ep.settled((await jq.enqueue({ project_slug: ep.project.slug, type: 'audio', episode_id: 'EP001', title: 'Narration',
      params: { episode_id: 'EP001', model: modelId, voice: 'mock-voice', sections: 'Chapter_01', speed: 1, force: false, no_overwrite: false, auto_retry: false } })).job_id)
    assert.equal(made.status, 'error', lines(made))
    // Its saved request as an interrupted run leaves it (outcome not known yet), and the Gateway
    // has since closed that request's hold.
    const saved = (await ep.part2Task())!
    const dead = saved.task_id!
    await recordTask(ep.audioDir, PART2, { ...saved, last_state: 'running' })
    service.patchJobScenario(dead, { failureCode: 'HOLD_CLOSED' })
    service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
    const before = service.providerSubmissionCount('tts')

    const repair = await reconcileAudio(ep.project.slug, 'EP001')
    assert.equal(repair.recovered, 0, repair.logs.join('\n'))
    assert.match(repair.outcomes[0]!.reason!, /HOLD_CLOSED/)
    assert.equal((await ep.part2Task())?.last_state, 'failed', 'the dead key is dropped: the next run sends a new one')
    if (modelId === FLEET) {
      assert.match(repair.outcomes[0]!.reason!, /asking for it again, free on your own Macs/)
      assert.ok(repair.fresh_job_id, repair.logs.join('\n'))
      const fresh = await ep.settled(repair.fresh_job_id!)
      assert.equal(fresh.status, 'done', lines(fresh))
      assert.equal(service.providerSubmissionCount('tts'), before + 1, 'one fresh request')
      assert.notEqual((await ep.part2Task())?.task_id, dead)
      assert.match(lines(fresh), /Joined 3 parts of Chapter 01/)
    } else {
      assert.match(repair.outcomes[0]!.reason!, /a paid voice is never asked again by itself/)
      assert.equal(repair.fresh_job_id, undefined)
      assert.equal(service.providerSubmissionCount('tts'), before, 'nothing bought')
      // Pressed again: the ended request is not even asked about.
      const polls = service.pollCount(dead)
      const again = await reconcileAudio(ep.project.slug, 'EP001')
      assert.match(again.outcomes[0]!.reason!, /the request ended/)
      assert.equal(service.pollCount(dead), polls, 'the Gateway was not contacted for it')
      service.clearQueuedScenarios('tts')
    }
  }
})
