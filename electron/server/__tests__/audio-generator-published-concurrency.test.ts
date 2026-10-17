import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { generateAudio, resolveAudioDir } = await import('../generators/audio.js')
const pm = await import('../services/project-manager.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { hashInput, recordTaskStrict } = await import('../services/task-manifest.js')
const jq = await import('../services/job-queue.js')

function ttsModel(id: string, providerSubmitConcurrency: number): Record<string, unknown> {
  return {
    id,
    display_name: id,
    // Both rows deliberately carry the same provider identity: only the
    // selected model's own publication may change the worker count.
    provider_id: 'same-provider-for-both-models',
    provider_name: 'Mock provider',
    description: '',
    credits_per_1000_characters: 1,
    minimum_credits: 1,
    maximum_input_characters: 15_000,
    supports_speed: true,
    minimum_speed: 0.5,
    maximum_speed: 2,
    supports_voice_cloning: false,
    preview_policy: '',
    generation_enabled: true,
    provider_submit_concurrency: providerSubmitConcurrency,
    controls: [],
  }
}

void test('audio generation honors selected-model fanout and independent New version identity', async () => {
  const service = await startMockGenStudioService()
  const previousOverride = process.env.STORY_STUDIO_TTS_CONCURRENCY
  delete process.env.STORY_STUDIO_TTS_CONCURRENCY
  try {
    await setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    const project = await pm.createProject({ name: 'Published audio fanout', episode_prefix: 'EP', episode_digits: 3 })
    const outputRoot = await pm.getProjectOutputRoot(project.slug)
    assert.ok(outputRoot)

    async function generate(episodeId: string, modelId: string, hint: number): Promise<number> {
      service.reset()
      service.ttsModels = [ttsModel(modelId, hint)]
      clearGenStudioCatalogCache()
      for (let i = 0; i < 3; i++) {
        service.queueScenario('tts', { waitForConcurrentTtsSubmissions: hint })
      }

      const narrationDir = path.join(outputRoot!, `${episodeId} - Script`)
      await fs.mkdir(narrationDir, { recursive: true })
      await fs.writeFile(path.join(narrationDir, `${episodeId}_Script_Narration.md`), [
        '# Narration',
        '## Chapter 1: One', 'One.',
        '## Chapter 2: Two', 'Two.',
        '## Chapter 3: Three', 'Three.',
      ].join('\n\n'))

      const job: any = {
        job_id: `audio-fanout-${episodeId}`,
        project_slug: project.slug,
        type: 'audio',
        episode_id: episodeId,
        title: 'Fanout test',
        status: 'running',
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
        output_lines: [],
        params: {
          episode_id: episodeId,
          model: modelId,
          voice: 'mock-voice',
          sections: 'all',
          speed: 1,
          force: false,
          no_overwrite: false,
        },
      }
      await generateAudio(job)
      assert.equal(job.item_progress?.concurrency, hint)
      return service.maxInFlightTtsSubmissionCount()
    }

    assert.equal(await generate('EP001', 'model-one', 1), 1)
    assert.equal(await generate('EP002', 'model-three', 3), 3)

    service.reset()
    service.ttsModels = [ttsModel('model-uncertain', 1)]
    clearGenStudioCatalogCache()
    service.queueScenario('tts', { states: ['failed'], failureCode: 'CLOUD_SUBMISSION_UNCERTAIN' })
    const uncertainEpisode = 'EP004'
    const uncertainNarrationDir = path.join(outputRoot!, `${uncertainEpisode} - Script`)
    await fs.mkdir(uncertainNarrationDir, { recursive: true })
    await fs.writeFile(path.join(uncertainNarrationDir, `${uncertainEpisode}_Script_Narration.md`), [
      '# Narration',
      '## Chapter 1: One', 'The request outcome must be reconciled.',
    ].join('\n\n'))
    const uncertainSource: any = {
      job_id: 'audio-uncertain-source', project_slug: project.slug, type: 'audio', episode_id: uncertainEpisode,
      title: 'Uncertain ordinary retry', status: 'running', created_at: new Date().toISOString(),
      started_at: new Date().toISOString(), finished_at: null, error: null, output_lines: [],
      params: {
        episode_id: uncertainEpisode, model: 'model-uncertain', voice: 'mock-voice', sections: 'all',
        speed: 1, force: false, no_overwrite: false,
      },
    }
    await assert.rejects(generateAudio(uncertainSource), /1 section\(s\) failed/)
    assert.equal(service.providerSubmissionCount('tts'), 1)
    const uncertainSubmission = service.submissions.find(item => item.operation === 'tts')!
    assert.ok(uncertainSubmission)

    const contradictoryRetry = structuredClone(uncertainSource)
    contradictoryRetry.job_id = 'audio-uncertain-contradictory'
    contradictoryRetry.output_lines = []
    contradictoryRetry.genstudio_jobs = [{
      id: uncertainSubmission.jobId,
      operation: 'voice.tts',
      state: 'failed',
      failure_code: 'CLOUD_SUBMISSION_UNCERTAIN',
      request_key: 'story-different-request-key',
      updated_at: new Date().toISOString(),
    }]
    await assert.rejects(generateAudio(contradictoryRetry), /Saved Gateway task identity does not match/)
    assert.equal(service.providerSubmissionCount('tts'), 1, 'contradictory task/key evidence stops before a fresh POST')

    // Evidence that names the same Gateway task but carries no key (written by a
    // reconcile after a restart) agrees with the manifest: reconnect, never "mismatch".
    const keylessRetry = structuredClone(uncertainSource)
    keylessRetry.job_id = 'audio-uncertain-keyless'
    keylessRetry.output_lines = []
    keylessRetry.genstudio_jobs = [{
      id: uncertainSubmission.jobId,
      operation: 'voice.tts',
      state: 'failed',
      failure_code: 'CLOUD_SUBMISSION_UNCERTAIN',
      request_key: null,
      updated_at: new Date().toISOString(),
    }]
    const keylessError = await generateAudio(keylessRetry).then(() => null, (e: Error) => e)
    assert.doesNotMatch(String(keylessError?.message), /identity does not match/)
    assert.equal(service.providerSubmissionCount('tts'), 1, 'keyless matching evidence reconnects with zero fresh POSTs')

    const wasPaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    let executionRetry: any
    let queuedRetryId = ''
    try {
      const incompleteParams = structuredClone(uncertainSource.params)
      incompleteParams.jobs_replace_failed_items = {
        version: 1, source_job_id: 'manual-incomplete-source', item_count: 2,
      }
      incompleteParams.genstudio_recovery.assets['EP004_Chapter_02.mp3'] = {
        operation: 'tts', job_id: 'missing-evidence-task', idempotency_key: 'story-missing-evidence-key', state: 'failed',
      }
      const incomplete = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'audio', episode_id: 'EP004-INCOMPLETE',
        title: 'Incomplete uncertain evidence', params: incompleteParams,
      })
      await jq.forceAbandonJob(project.slug, incomplete.job_id)
      await jq.mutateAuthoritativeJob(project.slug, incomplete.job_id, current => ({
        ...current,
        status: 'error',
        force_abandoned: undefined,
        finished_at: new Date().toISOString(),
        error: 'partial uncertainty evidence',
        genstudio_jobs: [{
          id: uncertainSubmission.jobId,
          operation: 'voice.tts',
          state: 'failed',
          failure_code: 'CLOUD_SUBMISSION_UNCERTAIN',
          request_key: uncertainSubmission.idempotencyKey,
          updated_at: new Date().toISOString(),
        }],
      }))
      assert.throws(
        () => jq.retryTerminalJob(project.slug, incomplete.job_id),
        /does not exactly match every current task identity/,
      )
      assert.equal(jq.getJob(incomplete.job_id)?.status, 'error', 'failed exactness check keeps the original row')
      assert.equal(service.providerSubmissionCount('tts'), 1)

      const queued = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'audio', episode_id: uncertainEpisode,
        title: 'Uncertain ordinary retry', params: structuredClone(uncertainSource.params),
      })
      await jq.forceAbandonJob(project.slug, queued.job_id)
      await jq.mutateAuthoritativeJob(project.slug, queued.job_id, current => ({
        ...current,
        status: 'error',
        force_abandoned: undefined,
        finished_at: new Date().toISOString(),
        error: 'submission outcome uncertain',
        genstudio_jobs: [{
          id: uncertainSubmission.jobId,
          operation: 'voice.tts',
          state: 'failed',
          failure_code: 'CLOUD_SUBMISSION_UNCERTAIN',
          request_key: uncertainSubmission.idempotencyKey,
          updated_at: new Date().toISOString(),
        }],
      }))
      const retried = jq.retryTerminalJob(project.slug, queued.job_id)
      queuedRetryId = retried.job_id
      executionRetry = jq.getJob(retried.job_id)
      assert.ok(executionRetry?.genstudio_jobs?.some((entry: any) => (
        entry.id === uncertainSubmission.jobId && entry.request_key === uncertainSubmission.idempotencyKey
      )), 'ordinary Retry carries the exact uncertainty evidence into its child')
      executionRetry.status = 'running'
      executionRetry.output_lines = []
      await assert.rejects(generateAudio(executionRetry), /1 section\(s\) failed/)
      assert.equal(service.providerSubmissionCount('tts'), 1, 'ordinary Retry reconnects the uncertain task with zero fresh POSTs')
    } finally {
      if (queuedRetryId && jq.getJob(queuedRetryId)) await jq.forceAbandonJob(project.slug, queuedRetryId)
      if (!wasPaused) await jq.setQueuePaused(false)
      await jq._waitForJobPersistenceForTesting()
    }

    service.reset()
    service.ttsModels = [ttsModel('model-versioned', 3)]
    clearGenStudioCatalogCache()
    service.queueScenario('tts', {})

    const episodeId = 'EP003'
    const narrationDir = path.join(outputRoot!, `${episodeId} - Script`)
    const narrationPath = path.join(narrationDir, `${episodeId}_Script_Narration.md`)
    await fs.mkdir(narrationDir, { recursive: true })
    await fs.writeFile(narrationPath, [
      '# Narration',
      '## Chapter 1: One', 'No digits here.',
    ].join('\n\n'))

    const audioDir = await resolveAudioDir(project.slug, narrationPath, episodeId)
    await fs.mkdir(audioDir, { recursive: true })
    const originalPath = path.join(audioDir, `${episodeId}_Chapter_01.mp3`)
    await fs.writeFile(originalPath, 'old audio')
    await recordTaskStrict(audioDir, path.basename(originalPath), {
      provider: 'genstudio',
      task_id: 'job-from-retired-account',
      submitted_at: new Date().toISOString(),
      input_hash: hashInput('No digits here.'),
      idempotency_key: 'story-old-task',
      operation: 'tts',
      last_state: 'succeeded',
    })

    const versionedJob: any = {
      job_id: 'audio-versioned-EP003',
      project_slug: project.slug,
      type: 'audio',
      episode_id: episodeId,
      title: 'New version test',
      status: 'running',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {
        episode_id: episodeId,
        model: 'model-versioned',
        voice: 'mock-voice',
        sections: 'all',
        speed: 1,
        force: true,
        no_overwrite: true,
      },
    }
    await generateAudio(versionedJob)
    assert.equal(await fs.readFile(originalPath, 'utf8'), 'old audio')
    assert.ok((await fs.stat(path.join(audioDir, `${episodeId}_Chapter_01_v2.mp3`))).size > 0)
    assert.equal(service.providerSubmissionCount('tts'), 1)

    service.reset()
    service.ttsModels = [ttsModel('model-versioned', 3)]
    clearGenStudioCatalogCache()
    service.queueScenario('tts', {})

    const regenerateJob: any = {
      ...versionedJob,
      job_id: 'audio-regenerate-EP003',
      title: 'Regenerate test',
      output_lines: [],
      params: {
        ...versionedJob.params,
        no_overwrite: false,
      },
    }
    await generateAudio(regenerateJob)
    assert.notEqual(await fs.readFile(originalPath, 'utf8'), 'old audio')
    assert.equal(service.providerSubmissionCount('tts'), 1)

    const sameActionRetry: any = {
      ...regenerateJob,
      job_id: 'audio-regenerate-retry-EP003',
      output_lines: [],
      params: {
        ...regenerateJob.params,
        generation_action: { id: 'audio-regenerate-action-one', kind: 'fresh' },
      },
    }
    regenerateJob.params.generation_action = { id: 'audio-regenerate-action-one', kind: 'fresh' }
    service.reset()
    service.ttsModels = [ttsModel('model-versioned', 3)]
    clearGenStudioCatalogCache()
    service.queueScenario('tts', {})
    await generateAudio(regenerateJob)
    assert.equal(service.providerSubmissionCount('tts'), 1)
    await generateAudio(sameActionRetry)
    assert.equal(service.providerSubmissionCount('tts'), 1, 'Jobs Retry must reuse the explicit action identity')

    const laterAction: any = {
      ...sameActionRetry,
      job_id: 'audio-regenerate-later-EP003',
      output_lines: [],
      params: {
        ...sameActionRetry.params,
        generation_action: { id: 'audio-regenerate-action-two', kind: 'fresh' },
      },
    }
    service.queueScenario('tts', {})
    await generateAudio(laterAction)
    assert.equal(service.providerSubmissionCount('tts'), 2, 'a second explicit action is intentionally distinct')
  } finally {
    clearGenStudioCatalogCache()
    if (previousOverride === undefined) delete process.env.STORY_STUDIO_TTS_CONCURRENCY
    else process.env.STORY_STUDIO_TTS_CONCURRENCY = previousOverride
    await service.close()
    await temp.cleanup()
  }
})

/**
 * DM0001, 2026-10-16 — a request whose acceptance was never recorded.
 *
 * The manifest writes its identity BEFORE the POST, so a submit whose response
 * never came back leaves `task_id: ''` next to a real `idempotency_key`. The
 * job's evidence then names the same request as `pending:<key>` and the
 * reconciler settles it as `not_created`. The identity guard required
 * `evidence.id === manifest.task_id`, which `pending:` can never satisfy, so it
 * called a legitimate pair a contradiction and failed every part the Gateway
 * had confirmed it never created — the owner's narration stopped with
 * "Saved Gateway task identity does not match …" while 26 other parts were
 * already on disk.
 *
 * These two tests take their own data dir: the test above calls `temp.cleanup()`,
 * which deletes `STORY_STUDIO_DATA_DIR`, so the module-level dir is gone by now.
 */
void test('a never-created pending request is not an identity contradiction', async () => {
  const own = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    service.ttsModels = [ttsModel('model-pending', 1)]
    clearGenStudioCatalogCache()
    const project = await pm.createProject({ name: 'Pending identity', episode_prefix: 'EP', episode_digits: 3 })
    const outputRoot = await pm.getProjectOutputRoot(project.slug)
    const episodeId = 'EP007'
    const narrationDir = path.join(outputRoot!, `${episodeId} - Script`)
    await fs.mkdir(narrationDir, { recursive: true })
    await fs.writeFile(path.join(narrationDir, `${episodeId}_Script_Narration.md`), [
      '# Narration',
      '## Chapter 1: One', 'The request was prepared but never accepted.',
    ].join('\n\n'))

    const job: any = {
      job_id: 'audio-pending-identity',
      project_slug: project.slug,
      type: 'audio',
      episode_id: episodeId,
      title: 'Pending identity',
      status: 'running',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {
        episode_id: episodeId, model: 'model-pending', voice: 'mock-voice', sections: 'all',
        speed: 1, force: false, no_overwrite: false,
      },
    }
    service.queueScenario('tts', { states: ['succeeded'] })
    await generateAudio(job)
    const firstSubmission = service.submissions.find(item => item.operation === 'tts')!
    assert.ok(firstSubmission, 'the first run submitted its part')

    const audioDir = await resolveAudioDir(project.slug, path.join(narrationDir, `${episodeId}_Script_Narration.md`), episodeId)
    const manifestPath = path.join(audioDir, '.task-manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    const outputName = Object.keys(manifest.tasks)[0]!
    const savedEntry = manifest.tasks[outputName]
    assert.equal(savedEntry.idempotency_key, firstSubmission.idempotencyKey)

    // Simulate the lost acceptance: the identity is durable, the task id is not.
    // Remove the bytes too, so this part is genuinely the one left to make.
    manifest.tasks[outputName] = { ...savedEntry, task_id: '' }
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    await fs.rm(path.join(audioDir, outputName), { force: true })

    // Evidence exactly as the reconciler leaves it after a 404 under the saved key.
    const pendingJob = structuredClone(job)
    pendingJob.job_id = 'audio-pending-identity-retry'
    pendingJob.output_lines = []
    pendingJob.genstudio_jobs = [{
      id: `pending:${firstSubmission.idempotencyKey}`,
      operation: 'voice.tts',
      state: 'not_created',
      queue_state: 'not_created',
      request_key: firstSubmission.idempotencyKey,
      updated_at: new Date().toISOString(),
    }]
    service.reset()
    service.ttsModels = [ttsModel('model-pending', 1)]
    clearGenStudioCatalogCache()
    service.queueScenario('tts', { states: ['succeeded'] })
    const error = await generateAudio(pendingJob).then(() => null, (e: Error) => e)
    assert.doesNotMatch(String(error?.message ?? ''), /identity does not match/,
      'a never-created request under the saved key is safe to submit again, not a contradiction')
    const resubmitted = service.submissions.find(item => item.operation === 'tts')
    assert.equal(resubmitted?.idempotencyKey, firstSubmission.idempotencyKey,
      'the resubmission keeps the same Story-to-provider identity')
  } finally {
    await setApiKey('genstudio', '')
    await service.close()
    await own.cleanup()
  }
})

void test('a contradictory task id under the saved key still fails closed', async () => {
  const own = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    service.ttsModels = [ttsModel('model-conflict', 1)]
    clearGenStudioCatalogCache()
    const project = await pm.createProject({ name: 'Contradictory identity', episode_prefix: 'EP', episode_digits: 3 })
    const outputRoot = await pm.getProjectOutputRoot(project.slug)
    const episodeId = 'EP008'
    const narrationDir = path.join(outputRoot!, `${episodeId} - Script`)
    await fs.mkdir(narrationDir, { recursive: true })
    await fs.writeFile(path.join(narrationDir, `${episodeId}_Script_Narration.md`), [
      '# Narration',
      '## Chapter 1: One', 'Two identities must never be reconciled silently.',
    ].join('\n\n'))

    const job: any = {
      job_id: 'audio-conflict-identity',
      project_slug: project.slug,
      type: 'audio',
      episode_id: episodeId,
      title: 'Contradictory identity',
      status: 'running',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {
        episode_id: episodeId, model: 'model-conflict', voice: 'mock-voice', sections: 'all',
        speed: 1, force: false, no_overwrite: false,
      },
    }
    service.queueScenario('tts', { states: ['succeeded'] })
    await generateAudio(job)
    const firstSubmission = service.submissions.find(item => item.operation === 'tts')!
    const audioDir = await resolveAudioDir(project.slug, path.join(narrationDir, `${episodeId}_Script_Narration.md`), episodeId)
    const manifestPath = path.join(audioDir, '.task-manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    const outputName = Object.keys(manifest.tasks)[0]!
    await fs.rm(path.join(audioDir, outputName), { force: true })

    // A REAL provider task id that does not agree with the manifest identity.
    const conflictingJob = structuredClone(job)
    conflictingJob.job_id = 'audio-conflict-identity-retry'
    conflictingJob.output_lines = []
    conflictingJob.genstudio_jobs = [{
      id: 'a-real-provider-task-that-is-not-this-one',
      operation: 'voice.tts',
      state: 'succeeded',
      request_key: firstSubmission.idempotencyKey,
      updated_at: new Date().toISOString(),
    }]
    service.reset()
    service.ttsModels = [ttsModel('model-conflict', 1)]
    clearGenStudioCatalogCache()
    await assert.rejects(
      generateAudio(conflictingJob),
      /identity does not match/,
      'a real task id under a different identity must stay fail-closed',
    )
    assert.equal(service.providerSubmissionCount('tts'), 0, 'no fresh POST after a contradictory identity')
  } finally {
    await setApiKey('genstudio', '')
    await service.close()
    await own.cleanup()
  }
})
