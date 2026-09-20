/** Task 11 — persist the TTS recovery boundary before the first paid dispatch. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import { waitFor } from './_timing.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

async function startTtsCreditRefusalProxy(targetBaseUrl: string, allowSubmissionsBeforeRefusal = 0): Promise<{
  baseUrl: string
  refusedSubmissions: () => number
  close: () => Promise<void>
}> {
  let refusals = 0
  let submissions = 0
  const server = http.createServer((request, response) => {
    const target = new URL(request.url || '/', targetBaseUrl)
    if (request.method === 'POST' && target.pathname === '/v1/audio/jobs'
      && ++submissions > allowSubmissionsBeforeRefusal) {
      refusals++
      request.resume()
      const body = Buffer.from(JSON.stringify({ detail: 'insufficient credits', code: 'insufficient_credits' }))
      response.writeHead(402, { 'content-type': 'application/json', 'content-length': String(body.length) })
      response.end(body)
      return
    }

    const headers = { ...request.headers }
    delete headers.host
    const upstream = http.request(target, { method: request.method, headers }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', error => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
      response.end(String(error.message || error))
    })
    request.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TTS refusal proxy did not bind a port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    refusedSubmissions: () => refusals,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

test('ordinary audio generation records its selected model before the first provider submission returns', async t => {
  const isolated = await useTempDataDir()
  const service = await startMockGenStudioService()
  t.after(async () => {
    await service.close()
    await isolated.cleanup()
  })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const { generateAudio, episodeDirForNarration } = await import('../generators/audio.js')
  const { readAudioTtsModelRecord } = await import('../services/audio-tts-model-record.js')

  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  service.ttsModels = [{
    id: 'task11-voice', display_name: 'Task 11 Voice', provider_id: 'mock-provider', provider_name: 'Mock provider',
    description: '', credits_per_1000_characters: 1, minimum_credits: 1,
    maximum_input_characters: 12_000, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
    supports_voice_cloning: false, preview_policy: '', generation_enabled: true,
    provider_submit_concurrency: 1, controls: [],
  }]
  client.clearGenStudioCatalogCache()
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })

  const project = await pm.createProject({ name: 'Task 11 TTS record', episode_prefix: 'EP', episode_digits: 4 })
  const outputRoot = await pm.getProjectOutputRoot(project.slug)
  assert.ok(outputRoot)
  const episode = 'EP0001'
  const narrationDir = path.join(outputRoot!, `${episode} - Script`)
  const narrationPath = path.join(narrationDir, `${episode}_Script_Narration.md`)
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(narrationPath, '# Narration\n\n## Chapter 01: Boundary\n\nRecord this request before dispatch.\n')

  const job: any = {
    job_id: 'task11-record-before-dispatch', project_slug: project.slug, episode_id: episode,
    type: 'audio', title: 'Record before dispatch', status: 'running', progress: 0, output_lines: [],
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, error: null,
    params: {
      episode_id: episode, model: 'task11-voice', voice: 'mock-voice', sections: 'all',
      speed: 1, force: false, no_overwrite: false,
    },
  }

  const barrier = service.pauseNextSubmitResponse()
  const running = generateAudio(job)
  await barrier.started
  try {
    const record = await readAudioTtsModelRecord(episodeDirForNarration(narrationPath))
    assert.equal(record?.model_id, 'task11-voice', 'an interruption after POST must retain the exact model boundary')
    assert.equal(record?.published_maximum_input_characters, 12_000)
    assert.ok((record?.request_budget || 0) > 0)
  } finally {
    barrier.release()
    await running
  }
})

test('a refused new model cannot replace the active boundary for valid prior audio', async t => {
  const isolated = await useTempDataDir()
  const service = await startMockGenStudioService()
  let refusalProxy: Awaited<ReturnType<typeof startTtsCreditRefusalProxy>> | null = null
  t.after(async () => {
    if (refusalProxy) await refusalProxy.close()
    await service.close()
    await isolated.cleanup()
  })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const { generateAudio, episodeDirForNarration, resolveAudioDir } = await import('../generators/audio.js')
  const { getAudioStatus } = await import('../services/audio-reconciler.js')
  const { readAudioTtsModelRecord } = await import('../services/audio-tts-model-record.js')

  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  service.ttsModels = [
    {
      id: 'task11-old-voice', display_name: 'Task 11 Old Voice', provider_id: 'mock-provider', provider_name: 'Mock provider',
      description: '', credits_per_1000_characters: 1, minimum_credits: 1,
      maximum_input_characters: 60, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
      supports_voice_cloning: false, preview_policy: '', generation_enabled: true,
      provider_submit_concurrency: 1, controls: [],
    },
    {
      id: 'task11-new-voice', display_name: 'Task 11 New Voice', provider_id: 'mock-provider', provider_name: 'Mock provider',
      description: '', credits_per_1000_characters: 1, minimum_credits: 1,
      maximum_input_characters: 12_000, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
      supports_voice_cloning: false, preview_policy: '', generation_enabled: true,
      provider_submit_concurrency: 1, controls: [],
    },
  ]
  client.clearGenStudioCatalogCache()
  for (let i = 0; i < 8; i++) service.queueScenario('tts', { states: ['accepted', 'succeeded'] })

  const project = await pm.createProject({ name: 'Task 11 TTS refusal', episode_prefix: 'EP', episode_digits: 4 })
  const outputRoot = await pm.getProjectOutputRoot(project.slug)
  assert.ok(outputRoot)
  const episode = 'EP0001'
  const narrationDir = path.join(outputRoot!, `${episode} - Script`)
  const narrationPath = path.join(narrationDir, `${episode}_Script_Narration.md`)
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(
    narrationPath,
    '# Narration\n\n## Chapter 01: Existing audio\n\nThe earlier voice remains the active, usable episode output when a newly selected paid request is refused before any new audio is returned.\n',
  )

  const makeJob = (id: string, model: string, fresh = false): any => ({
    job_id: id, project_slug: project.slug, episode_id: episode,
    type: 'audio', title: id, status: 'running', progress: 0, output_lines: [],
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, error: null,
    params: {
      episode_id: episode, model, voice: 'mock-voice', sections: 'all',
      speed: 1, force: fresh, no_overwrite: false,
      ...(fresh ? { generation_action: { id, kind: 'fresh' } } : {}),
    },
  })

  await generateAudio(makeJob('task11-old-valid-audio', 'task11-old-voice'))
  const episodeDir = episodeDirForNarration(narrationPath)
  const oldRecord = await readAudioTtsModelRecord(episodeDir)
  assert.equal(oldRecord?.model_id, 'task11-old-voice')
  const oldStatus = await getAudioStatus(project.slug, episode)
  assert.equal(oldStatus.missing.length, 0)
  assert.ok(oldStatus.expected.length > 1, 'the prior model must have a distinct multipart boundary')
  const oldBytes = new Map(await Promise.all(oldStatus.present.map(async filename => [
    filename,
    await fs.readFile(path.join(oldStatus.audio_dir, filename), 'base64'),
  ] as const)))
  const acceptedBeforeRefusal = service.providerSubmissionCount('tts')

  refusalProxy = await startTtsCreditRefusalProxy(service.baseUrl)
  await settings.setGenStudioUrl(refusalProxy.baseUrl)
  client.clearGenStudioCatalogCache()
  await assert.rejects(
    () => generateAudio(makeJob('task11-new-model-refused', 'task11-new-voice', true)),
    /insufficient credits/i,
  )

  assert.equal(refusalProxy.refusedSubmissions(), 1)
  assert.equal(service.providerSubmissionCount('tts'), acceptedBeforeRefusal, 'the refused request created no new provider task')
  assert.equal(
    (await readAudioTtsModelRecord(episodeDir))?.model_id,
    'task11-old-voice',
    'a refusal before any new output must preserve the prior active model boundary',
  )
  for (const [filename, bytes] of oldBytes) {
    assert.equal(await fs.readFile(path.join(oldStatus.audio_dir, filename), 'base64'), bytes)
  }
  const reconciled = await getAudioStatus(project.slug, episode)
  assert.equal(reconciled.missing.length, 0, 'the retained prior audio must still reconcile as complete')
  assert.deepEqual(reconciled.expected.map(item => item.filename), oldStatus.expected.map(item => item.filename))
})

test('a successful replacement without audio_chapters commits its new implicit base-file boundary', async t => {
  const isolated = await useTempDataDir()
  const service = await startMockGenStudioService()
  t.after(async () => {
    await service.close()
    await isolated.cleanup()
  })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const { generateAudio, episodeDirForNarration, resolveAudioDir } = await import('../generators/audio.js')
  const { readAudioTtsModelRecord } = await import('../services/audio-tts-model-record.js')
  const { getAudioStatus } = await import('../services/audio-reconciler.js')

  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  service.setAccountOverviewForKey(MOCK_GENSTUDIO_FULL_KEY, { credit_balance: 10_000 })
  await client.refreshGenStudioAdmission(MOCK_GENSTUDIO_FULL_KEY)
  service.ttsModels = [
    {
      id: 'task11-implicit-old', display_name: 'Task 11 Implicit Old', provider_id: 'mock-provider', provider_name: 'Mock provider',
      description: '', credits_per_1000_characters: 1, minimum_credits: 1,
      maximum_input_characters: 12_000, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
      supports_voice_cloning: false, preview_policy: '', generation_enabled: true,
      provider_submit_concurrency: 1, controls: [],
    },
    {
      id: 'task11-implicit-new', display_name: 'Task 11 Implicit New', provider_id: 'mock-provider', provider_name: 'Mock provider',
      description: '', credits_per_1000_characters: 1, minimum_credits: 1,
      maximum_input_characters: 60, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
      supports_voice_cloning: false, preview_policy: '', generation_enabled: true,
      provider_submit_concurrency: 1, controls: [],
    },
  ]
  client.clearGenStudioCatalogCache()
  for (let i = 0; i < 12; i++) service.queueScenario('tts', { states: ['accepted', 'succeeded'] })

  const project = await pm.createProject({ name: 'Task 11 implicit active audio', episode_prefix: 'EP', episode_digits: 4 })
  const outputRoot = await pm.getProjectOutputRoot(project.slug)
  assert.ok(outputRoot)
  const episode = 'EP0001'
  const narrationDir = path.join(outputRoot!, `${episode} - Script`)
  const narrationPath = path.join(narrationDir, `${episode}_Script_Narration.md`)
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(
    narrationPath,
    '# Narration\n\n## Chapter 01: Implicit base audio\n\nBefore Audio Assembly creates a selection sidecar, successful base TTS files are implicitly active. A completed model replacement must move the episode boundary only after all of its parts exist.\n',
  )

  const makeJob = (id: string, model: string, force = false): any => ({
    job_id: id, project_slug: project.slug, episode_id: episode,
    type: 'audio', title: id, status: 'running', progress: 0, output_lines: [],
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, error: null,
    params: {
      episode_id: episode, model, voice: 'mock-voice', sections: 'all',
      speed: 1, force, no_overwrite: false,
      ...(force ? { generation_action: { id, kind: 'fresh' } } : {}),
    },
  })

  await generateAudio(makeJob('task11-implicit-old', 'task11-implicit-old'))
  const episodeDir = episodeDirForNarration(narrationPath)
  assert.equal((await readAudioTtsModelRecord(episodeDir))?.model_id, 'task11-implicit-old')
  await fs.rm(path.join(episodeDir, 'audio_chapters.json'), { force: true })
  await assert.rejects(
    () => fs.stat(path.join(episodeDir, 'audio_chapters.json')),
    (error: any) => error?.code === 'ENOENT',
  )

  await generateAudio(makeJob('task11-implicit-new', 'task11-implicit-new', true))

  const newSubmissions = service.submissions.filter(submission => (
    submission.operation === 'tts'
    && submission.parsedBody?.model_id === 'task11-implicit-new'
    && !submission.replay
  ))
  assert.ok(newSubmissions.length > 1, 'the selected model must actually produce multipart replacement tasks')
  const audioDir = await resolveAudioDir(project.slug, narrationPath, episode)
  const newPartFiles = (await fs.readdir(audioDir)).filter(file => /_part\d+\.mp3$/i.test(file)).sort()
  assert.equal(newPartFiles.length, newSubmissions.length)
  await assert.rejects(
    () => fs.stat(path.join(episodeDir, 'audio_chapters.json')),
    (error: any) => error?.code === 'ENOENT',
  )
  assert.equal((await readAudioTtsModelRecord(episodeDir))?.model_id, 'task11-implicit-new')
  const active = await getAudioStatus(project.slug, episode)
  assert.deepEqual(active.expected.map(item => item.filename), newPartFiles)
  assert.deepEqual(active.present.sort(), newPartFiles)
  assert.deepEqual(active.missing, [])

  const submissionsBeforeNoOp = service.providerSubmissionCount('tts')
  await generateAudio(makeJob('task11-implicit-existing-noop', 'task11-implicit-new'))
  assert.equal(
    service.providerSubmissionCount('tts'),
    submissionsBeforeNoOp,
    'an ordinary same-model run over complete active files must remain a zero-write no-op',
  )
  assert.equal((await readAudioTtsModelRecord(episodeDir))?.model_id, 'task11-implicit-new')
  assert.deepEqual((await getAudioStatus(project.slug, episode)).expected.map(item => item.filename), newPartFiles)
})

test('a replacement cannot partially rewrite a two-section selector or advance its model boundary', async t => {
  const isolated = await useTempDataDir()
  const service = await startMockGenStudioService()
  t.after(async () => {
    await service.close()
    await isolated.cleanup()
  })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const { generateAudio, episodeDirForNarration, resolveAudioDir } = await import('../generators/audio.js')
  const { readAudioTtsModelRecord } = await import('../services/audio-tts-model-record.js')

  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  service.setAccountOverviewForKey(MOCK_GENSTUDIO_FULL_KEY, { credit_balance: 10_000 })
  await client.refreshGenStudioAdmission(MOCK_GENSTUDIO_FULL_KEY)
  service.ttsModels = [
    {
      id: 'task11-atomic-old', display_name: 'Task 11 Atomic Old', provider_id: 'mock-provider', provider_name: 'Mock provider',
      description: '', credits_per_1000_characters: 1, minimum_credits: 1,
      maximum_input_characters: 12_000, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
      supports_voice_cloning: false, preview_policy: '', generation_enabled: true,
      provider_submit_concurrency: 1, controls: [],
    },
    {
      id: 'task11-atomic-new', display_name: 'Task 11 Atomic New', provider_id: 'mock-provider', provider_name: 'Mock provider',
      description: '', credits_per_1000_characters: 1, minimum_credits: 1,
      maximum_input_characters: 12_000, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
      supports_voice_cloning: false, preview_policy: '', generation_enabled: true,
      provider_submit_concurrency: 1, controls: [],
    },
  ]
  client.clearGenStudioCatalogCache()
  for (let i = 0; i < 6; i++) service.queueScenario('tts', { states: ['accepted', 'succeeded'] })

  const project = await pm.createProject({ name: 'Task 11 atomic selector', episode_prefix: 'EP', episode_digits: 4 })
  const outputRoot = await pm.getProjectOutputRoot(project.slug)
  assert.ok(outputRoot)
  const episode = 'EP0001'
  const narrationDir = path.join(outputRoot!, `${episode} - Script`)
  const narrationPath = path.join(narrationDir, `${episode}_Script_Narration.md`)
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(
    narrationPath,
    '# Narration\n\n## Chapter 01: First\n\nThe first selected chapter will be regenerated.\n\n## Chapter 02: Second\n\nThe second selected chapter remains valid but has no evidence from this replacement.\n',
  )

  const makeJob = (id: string, model: string): any => ({
    job_id: id, project_slug: project.slug, episode_id: episode,
    type: 'audio', title: id, status: 'running', progress: 0, output_lines: [],
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, error: null,
    params: {
      episode_id: episode, model, voice: 'mock-voice', sections: 'all',
      speed: 1, force: false, no_overwrite: false,
    },
  })

  await generateAudio(makeJob('task11-atomic-old', 'task11-atomic-old'))
  const episodeDir = episodeDirForNarration(narrationPath)
  const audioDir = await resolveAudioDir(project.slug, narrationPath, episode)
  const first = `${episode}_Chapter_01.mp3`
  const second = `${episode}_Chapter_02.mp3`
  const sidecarPath = path.join(episodeDir, 'audio_chapters.json')
  const originalSidecar = `${JSON.stringify({
    sections: [
      { slug: 'Chapter_01', source_file: first, source_files: [first] },
      { slug: 'Chapter_02', source_file: second, source_files: [second] },
    ],
  }, null, 2)}\n`
  await fs.writeFile(sidecarPath, originalSidecar)
  await fs.rm(path.join(audioDir, first))

  await assert.rejects(
    () => generateAudio(makeJob('task11-atomic-new', 'task11-atomic-new')),
    (error: any) => {
      assert.match(String(error?.message || error), /activate|selection/i)
      assert.match(String(error?.message || error), /Retry/i)
      return true
    },
    'a complete paid request must not report Done when its replacement cannot become active',
  )

  assert.equal(await fs.readFile(sidecarPath, 'utf8'), originalSidecar)
  assert.equal(
    (await readAudioTtsModelRecord(episodeDir))?.model_id,
    'task11-atomic-old',
    'one eligible section cannot activate a model boundary for the whole episode',
  )
})

test('an interrupted partial replacement keeps the old active boundary and Retry reuses its durable task', async t => {
  const isolated = await useTempDataDir()
  const service = await startMockGenStudioService()
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const jq = await import('../services/job-queue.js')
  const { generateAudio, episodeDirForNarration } = await import('../generators/audio.js')
  const { readAudioTtsModelRecord } = await import('../services/audio-tts-model-record.js')
  const { getAudioStatus } = await import('../services/audio-reconciler.js')
  const { readManifest } = await import('../services/task-manifest.js')
  const wasPaused = jq.isQueuePaused()
  let queuedJobId = ''
  let projectSlug = ''
  let startedRuns = 0
  let releasedRuns = 0
  let releaseHeldSubmission: (() => void) | undefined
  const stopObservingPumps = jq._observeQueuePumpsForTesting((type, releasedJobId) => {
    if (type === 'audio' && releasedJobId === queuedJobId) releasedRuns++
  })
  t.after(async () => {
    let safeToRemoveFixture = false
    try {
      await jq.setQueuePaused(true)
      releaseHeldSubmission?.()
      const queued = queuedJobId ? jq.getJob(queuedJobId) : undefined
      // runJob publishes running before entering our executor wrapper.
      const requiredReleases = Math.max(startedRuns,
        releasedRuns + (queued?.status === 'running' && startedRuns === releasedRuns ? 1 : 0))
      if (queued) {
        if (!['done', 'error', 'cancelled'].includes(queued.status)) {
          t.diagnostic(JSON.stringify({
            status: queued.status, error: queued.error, progress: queued.item_progress,
            output: queued.output_lines.slice(-6), startedRuns, releasedRuns,
            providerTasks: service.providerSubmissionCount('tts'),
          }))
          await jq.forceAbandonJob(projectSlug, queuedJobId)
        }
      }
      // A published job status and an idle persistence queue do not join the
      // executor. The existing release observer runs after runJob's finally.
      await waitFor(() => releasedRuns >= requiredReleases && releasedRuns >= startedRuns,
        { label: 'TTS fixture workers to release their queue slots' })
      if (queuedJobId && jq.getJob(queuedJobId)) jq.removeTerminalJob(projectSlug, queuedJobId)
      assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true,
        'the real TTS queue worker and persistence must drain before removing STORY_STUDIO_DATA_DIR')
      await jq.setQueuePaused(wasPaused)
      assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true,
        'restoring the queue must not leave late TTS fixture persistence')
      safeToRemoveFixture = true
    } finally {
      stopObservingPumps()
      try {
        await service.close()
      } finally {
        if (safeToRemoveFixture) await isolated.cleanup()
        else t.diagnostic('Retained isolated fixture because queue shutdown did not prove quiescence.')
      }
    }
  })

  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  // The preceding 402 deliberately leaves the shared admission key on hold.
  // A strictly higher published balance is the production-supported proof
  // that paid submissions may resume; do not bypass that gate in this fixture.
  service.setAccountOverviewForKey(MOCK_GENSTUDIO_FULL_KEY, { credit_balance: 10_000 })
  await client.refreshGenStudioAdmission(MOCK_GENSTUDIO_FULL_KEY)
  service.ttsModels = [
    {
      id: 'task11-active-old', display_name: 'Task 11 Active Old', provider_id: 'mock-provider', provider_name: 'Mock provider',
      description: '', credits_per_1000_characters: 1, minimum_credits: 1,
      maximum_input_characters: 12_000, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
      supports_voice_cloning: false, preview_policy: '', generation_enabled: true,
      provider_submit_concurrency: 1, controls: [],
    },
    {
      id: 'task11-partial-new', display_name: 'Task 11 Partial New', provider_id: 'mock-provider', provider_name: 'Mock provider',
      description: '', credits_per_1000_characters: 1, minimum_credits: 1,
      maximum_input_characters: 60, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
      supports_voice_cloning: false, preview_policy: '', generation_enabled: true,
      provider_submit_concurrency: 1, controls: [],
    },
  ]
  client.clearGenStudioCatalogCache()
  for (let i = 0; i < 12; i++) service.queueScenario('tts', { states: ['accepted', 'succeeded'] })

  const project = await pm.createProject({ name: 'Task 11 TTS partial recovery', episode_prefix: 'EP', episode_digits: 4 })
  projectSlug = project.slug
  const outputRoot = await pm.getProjectOutputRoot(project.slug)
  assert.ok(outputRoot)
  const episode = 'EP0001'
  const narrationDir = path.join(outputRoot!, `${episode} - Script`)
  const narrationPath = path.join(narrationDir, `${episode}_Script_Narration.md`)
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(
    narrationPath,
    // Exactly two parts prove one completed identity plus one pending part.
    // Five parts made the four-second wait race four jittered provider polls.
    '# Narration\n\n## Chapter 01: Partial recovery\n\nA paid part completes before pause. Resume must keep it and finish the replacement.\n',
  )
  const makeJob = (id: string, model: string, fresh = false): any => ({
    job_id: id, project_slug: project.slug, episode_id: episode,
    type: 'audio', title: id, status: 'running', progress: 0, output_lines: [],
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, error: null,
    params: {
      episode_id: episode, model, voice: 'mock-voice', sections: 'all',
      speed: 1, force: fresh, no_overwrite: false,
      ...(fresh ? { generation_action: { id: 'task11-partial-action', kind: 'fresh' } } : {}),
    },
  })

  await generateAudio(makeJob('task11-partial-old', 'task11-active-old'))
  const episodeDir = episodeDirForNarration(narrationPath)
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
    sections: [{ slug: 'Chapter_01', source_file: `${episode}_Chapter_01.mp3` }],
  }))
  assert.equal((await readAudioTtsModelRecord(episodeDir))?.model_id, 'task11-active-old')
  const oldStatus = await getAudioStatus(project.slug, episode)
  assert.equal(oldStatus.missing.length, 0)
  assert.equal(oldStatus.expected.length, 1)
  const submissionsBeforeReplacement = service.providerSubmissionCount('tts')

  await jq.setQueuePaused(true)
  jq.registerExecutor('audio', job => {
    startedRuns++
    return generateAudio(job)
  })
  const barrier = service.pauseNextSubmitResponse()
  releaseHeldSubmission = () => barrier.release()
  const queued = jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type: 'audio',
    episode_id: episode,
    title: 'Interrupted partial replacement',
    params: makeJob('ignored', 'task11-partial-new', true).params,
  })
  queuedJobId = queued.job_id
  await jq.setQueuePaused(false)
  await barrier.started
  try {
    const paused = await jq.pauseJob(queued.job_id)
    assert.equal(paused?.pause_requested, true)
  } finally {
    barrier.release()
  }
  await waitFor(
    () => jq.getJob(queued.job_id)?.status === 'paused' && releasedRuns === 1,
    { label: 'TTS job to reach paused state', timeoutMs: 2_000, pollMs: 10 },
  )
  const pausedJob = jq.getJob(queued.job_id)
  assert.equal(pausedJob?.status, 'paused')

  const partialFiles = (await fs.readdir(oldStatus.audio_dir)).filter(file => /_part\d+\.mp3$/i.test(file))
  assert.equal(partialFiles.length, 1, 'only the accepted first replacement part exists at the pause boundary')
  assert.equal(service.providerSubmissionCount('tts'), submissionsBeforeReplacement + 1)
  assert.equal(
    (await readAudioTtsModelRecord(episodeDir))?.model_id,
    'task11-active-old',
    'partial replacement bytes do not become the active episode boundary',
  )
  const completedFirstSubmission = service.submissions.find(submission => (
    submission.operation === 'tts'
    && submission.parsedBody?.model_id === 'task11-partial-new'
  ))
  assert.ok(completedFirstSubmission)
  const partialManifest = await readManifest(oldStatus.audio_dir)
  const firstEntry = partialManifest.tasks[partialFiles[0]!]
  const firstCheckpoint = pausedJob?.params.genstudio_recovery?.assets?.[partialFiles[0]!]
  assert.equal(firstEntry?.last_state, 'succeeded')
  assert.equal(firstCheckpoint?.state, 'succeeded')
  assert.equal(firstCheckpoint?.job_id, firstEntry?.task_id)
  assert.equal(firstCheckpoint?.idempotency_key, firstEntry?.idempotency_key)

  assert.ok(await jq.resumeJob(queued.job_id), 'Resume must requeue the same durable job record')
  await waitFor(() => {
    const status = jq.getJob(queued.job_id)?.status
    return releasedRuns === 2 && (status === 'done' || status === 'error' || status === 'cancelled')
  }, { label: 'resumed TTS job to reach a terminal state', timeoutMs: 4_000, pollMs: 10 })
  assert.equal(
    jq.getJob(queued.job_id)?.status,
    'done',
    `the resumed TTS job must settle normally: ${jq.getJob(queued.job_id)?.error || 'no recorded error'}`,
  )

  const completeFiles = (await fs.readdir(oldStatus.audio_dir))
    .filter(file => /_part\d+\.mp3$/i.test(file))
    .sort()
  assert.equal(completeFiles.length, 2)
  const activeSidecar = JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf8'))
  assert.deepEqual(activeSidecar.sections[0]?.source_files, completeFiles)
  assert.equal((await readAudioTtsModelRecord(episodeDir))?.model_id, 'task11-partial-new')
  const firstIdentityRequests = service.submissions
    .filter(submission => submission.idempotencyKey === completedFirstSubmission.idempotencyKey)
  assert.equal(firstIdentityRequests.length, 2, 'Resume makes one transport replay for the completed first part')
  assert.equal(firstIdentityRequests.filter(submission => !submission.replay).length, 1)
  assert.equal(firstIdentityRequests.filter(submission => submission.replay).length, 1)
  assert.ok(firstIdentityRequests.every(submission => submission.jobId === completedFirstSubmission.jobId))
  assert.equal(service.replayCount(completedFirstSubmission.jobId), 1)
  const resumedCheckpoint = jq.getJob(queued.job_id)?.params.genstudio_recovery?.assets?.[partialFiles[0]!]
  assert.equal(resumedCheckpoint?.state, 'succeeded')
  assert.equal(resumedCheckpoint?.job_id, firstEntry?.task_id)
  assert.equal(resumedCheckpoint?.idempotency_key, firstEntry?.idempotency_key)
  assert.equal(
    service.providerSubmissionCount('tts'),
    submissionsBeforeReplacement + completeFiles.length,
    'the replay creates no second provider task; only never-submitted parts create paid work',
  )
})
