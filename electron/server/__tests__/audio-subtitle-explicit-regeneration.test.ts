/**
 * Route-to-provider proof for the two audio workflows.  A deliberate action
 * has one durable key across an HTTP replay and Jobs Retry; a later click is
 * intentionally a new key.  Ordinary recovery remains unmarked.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

void test('audio and subtitles route replay and Jobs Retry keep one provider request per deliberate action', async () => {
  const isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const service = await startMockGenStudioService()
  let stopObservingPumps: (() => void) | null = null
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const releasedJobIds = new Set<string>()
    stopObservingPumps = jq._observeQueuePumpsForTesting((_type, releasedJobId) => {
      if (releasedJobId) releasedJobIds.add(releasedJobId)
    })
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')

    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()

    const project = await pm.createProject({ name: 'Audio action identity fixture', episode_prefix: 'EP', episode_digits: 4 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'One chapter', logline: 'A bounded action fixture.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    }], 'mock-chat-v1')
    const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
    const episodeId = accepted.episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
    await Promise.all([paths.script_dir, paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
    await fs.writeFile(paths.narration_docx, '# Narration\n\n## Chapter 01: Fixture\n\nA short line for the mock audio request.\n')

    const terminal = async (jobId: string, label: string) => {
      try {
        await waitFor(() => {
          const status = jq.getJob(jobId)?.status
          return (status === 'done' || status === 'error' || status === 'cancelled')
            && releasedJobIds.has(jobId)
        }, { label, timeoutMs: 10_000 })
      } catch (error) {
        const job = jq.getJob(jobId)
        const diagnostics = JSON.stringify({
          status: job?.status ?? null,
          error: job?.error ?? null,
          output_tail: Array.isArray(job?.output_lines) ? job.output_lines.slice(-5) : [],
          release_observed: releasedJobIds.has(jobId),
        })
        if (error instanceof Error) error.message = `${error.message}; queue=${diagnostics}`
        throw error
      }
    }
    const jobId = (response: request.Response) => String(response.body.job_id || response.body.job?.job_id || '')
    const sameJob = (a: request.Response, b: request.Response, label: string) => {
      assert.ok([200, 201].includes(a.status), `${label}: ${JSON.stringify(a.body)}`)
      assert.ok([200, 201].includes(b.status), `${label}: ${JSON.stringify(b.body)}`)
      assert.equal(jobId(a), jobId(b), `${label}: same operation rejoined one queue job`)
    }

    const audioBody = (operationId?: string, force = true) => ({
      episode_id: episodeId, model: 'mock-tts-v1', voice: 'mock-voice', sections: 'all', force,
      ...(operationId ? { operation_id: operationId } : {}),
    })
    const audioAction = '11111111-1111-4111-8111-111111111111'
    // A settled failure makes the queue Retry meaningful without exercising
    // the separate automatic free-retry policy.
    service.queueScenario('tts', { states: ['accepted', 'failed'], failureCode: 'provider_error', finalCredits: 1 })
    const [audioFirst, audioReplay] = await Promise.all([
      request(app).post(`/api/projects/${project.slug}/generate/audio`).send(audioBody(audioAction)),
      request(app).post(`/api/projects/${project.slug}/generate/audio`).send(audioBody(audioAction)),
    ])
    sameJob(audioFirst, audioReplay, 'audio HTTP replay')
    await terminal(jobId(audioFirst), 'first audio action to settle')
    assert.equal(service.providerSubmissionCount('tts'), 1, 'one audio action made one provider POST')

    const audioRetry = await request(app).post(`/api/projects/${project.slug}/jobs/${jobId(audioFirst)}/retry`)
    assert.equal(audioRetry.status, 202, JSON.stringify(audioRetry.body))
    await terminal(jobId(audioRetry), 'audio Jobs Retry to settle')
    assert.equal(service.providerSubmissionCount('tts'), 1, 'audio Jobs Retry replayed the first action key')

    service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
    const audioNew = await request(app).post(`/api/projects/${project.slug}/generate/audio`)
      .send(audioBody('22222222-2222-4222-8222-222222222222'))
    assert.equal(audioNew.status, 201, JSON.stringify(audioNew.body))
    await terminal(jobId(audioNew), 'second audio action to settle')
    assert.equal(service.providerSubmissionCount('tts'), 2, 'a later audio action made one intentionally fresh POST')

    const audioOrdinary = await request(app).post(`/api/projects/${project.slug}/generate/audio`).send(audioBody(undefined, false))
    assert.equal(audioOrdinary.status, 201, JSON.stringify(audioOrdinary.body))
    await terminal(jobId(audioOrdinary), 'ordinary audio recovery to settle')
    assert.equal(service.providerSubmissionCount('tts'), 2, 'ordinary audio recovery kept its current output')
    assert.equal(jq.getJob(jobId(audioOrdinary))?.params.generation_action, undefined, 'ordinary audio recovery stays unmarked')

    // The valid chapter output above is active; chapter-local repair must not need a full mix.
    const sourceFile = `${episodeId}_Chapter_01.mp3`
    await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
      gap_duration_s: 0,
      sections: [{
        slug: 'Chapter_01',
        duration_s: 1,
        source_file: sourceFile,
        source_files: [sourceFile],
      }],
    }))

    // A manual fresh attempt is narrower than ordinary force generation: the
    // server must bind it to this exact stopped section checkpoint and preserve
    // the old request evidence while the new take stays inactive.
    const restoreAudioExecutor = jq._setExecutorForTesting('audio', async () => {})
    const stoppedSource = await (async () => {
      try {
        const source = await jq.enqueue({
          project_slug: project.slug,
          type: 'audio',
          episode_id: episodeId,
          title: 'Stopped Chapter 01 version',
          params: {
            episode_id: episodeId,
            model: 'mock-tts-v1',
            voice: 'mock-voice',
            sections: 'Chapter_01',
            speed: 1,
            force: true,
            no_overwrite: true,
          },
        })
        await terminal(source.job_id, 'manual-redo source fixture to stop')
        return source
      } finally {
        restoreAudioExecutor()
      }
    })()
    const sourceTaskId = 'voice-source-task'
    const sourceRequestKey = 'voice-source-request-key'
    const sourceAsset = `${episodeId}_Chapter_01_v2.mp3`
    await jq.mutateAuthoritativeJob(project.slug, stoppedSource.job_id, current => {
      current.status = 'error'
      current.error = 'The earlier voice request did not settle locally.'
      current.finished_at = new Date().toISOString()
      current.params.genstudio_recovery = {
        version: 1,
        route: 'genstudio',
        assets: {
          [sourceAsset]: {
            operation: 'tts',
            job_id: sourceTaskId,
            idempotency_key: sourceRequestKey,
            state: 'accepted',
          },
        },
      }
      current.genstudio_jobs = [{
        id: sourceTaskId,
        operation: 'voice.tts',
        state: 'accepted',
        request_key: sourceRequestKey,
        updated_at: new Date().toISOString(),
      }]
      return current
    })

    const manualBody = (operationId: string) => ({
      episode_id: episodeId,
      model: 'mock-tts-v1',
      voice: 'mock-voice',
      sections: 'Chapter_01',
      speed: 1,
      force: true,
      no_overwrite: true,
      operation_id: operationId,
      manual_redo: { intent: 'replace_unresolved', source_job_id: stoppedSource.job_id },
    })
    const beforeManual = service.providerSubmissionCount('tts')
    const mismatchedEvidenceAction = '55555555-5555-4555-8555-555555555555'
    await jq.mutateAuthoritativeJob(project.slug, stoppedSource.job_id, current => {
      current.params.genstudio_recovery.assets[sourceAsset].idempotency_key = 'wrong-current-key'
      return current
    })
    const mismatchedEvidence = await request(app).post(`/api/projects/${project.slug}/generate/audio`)
      .send(manualBody(mismatchedEvidenceAction))
    if (mismatchedEvidence.status === 201) {
      await terminal(jobId(mismatchedEvidence), 'unexpected pre-fix mismatched-evidence job to settle')
    }
    assert.equal(mismatchedEvidence.status, 409, JSON.stringify(mismatchedEvidence.body))
    assert.equal(service.providerSubmissionCount('tts'), beforeManual, 'mismatched source evidence submits no voice work')
    assert.equal(jq.getJob(stoppedSource.job_id)?.force_abandoned, undefined, 'refused source remains owned')
    await jq.mutateAuthoritativeJob(project.slug, stoppedSource.job_id, current => {
      current.params.genstudio_recovery.assets[sourceAsset].idempotency_key = sourceRequestKey
      return current
    })

    const manualAction = '66666666-6666-4666-8666-666666666666'
    service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
    const [manualFirst, manualReplay] = await Promise.all([
      request(app).post(`/api/projects/${project.slug}/generate/audio`).send(manualBody(manualAction)),
      request(app).post(`/api/projects/${project.slug}/generate/audio`).send(manualBody(manualAction)),
    ])
    sameJob(manualFirst, manualReplay, 'source-bound audio version HTTP replay')
    await terminal(jobId(manualFirst), 'source-bound audio version to settle')
    assert.equal(service.providerSubmissionCount('tts'), beforeManual + 1, 'one accepted fresh voice action made one provider POST')
    const retainedSource = jq.getJob(stoppedSource.job_id)!
    assert.ok(retainedSource.force_abandoned, 'only the exact stopped source is abandoned after destination admission')
    assert.equal(retainedSource.genstudio_jobs?.[0]?.id, sourceTaskId, 'source provider evidence is retained')
    assert.equal(retainedSource.params.genstudio_recovery.assets[sourceAsset].idempotency_key, sourceRequestKey, 'source checkpoint is retained')
    const replacement = jq.getJob(jobId(manualFirst))!
    assert.equal(replacement.params.manual_redo.source_job_id, stoppedSource.job_id)
    assert.deepEqual(replacement.params.manual_redo.sections, ['Chapter_01'])
    assert.deepEqual(replacement.params.manual_redo.source_assets, [{
      asset_key: sourceAsset,
      task_id: sourceTaskId,
      idempotency_key: sourceRequestKey,
    }])
    const activeAfterVersion = JSON.parse(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'))
    assert.deepEqual(activeAfterVersion.sections[0].source_files, [sourceFile], 'new version stays inactive')
    assert.ok((await fs.readdir(paths.audio_dir)).includes(`${episodeId}_Chapter_01_v2.mp3`), 'fresh version is saved beside active audio')

    // Admission abandons the source before the HTTP response. A lost response
    // must still replay the accepted destination even if mutable setup has
    // since disappeared; current credentials/catalog/source are for new work.
    await secrets.setApiKey('genstudio', '')
    try {
      const admittedReplay = await request(app).post(`/api/projects/${project.slug}/generate/audio`)
        .send(manualBody(manualAction))
      assert.equal(admittedReplay.status, 200, JSON.stringify(admittedReplay.body))
      assert.equal(jobId(admittedReplay), jobId(manualFirst))
      assert.equal(service.providerSubmissionCount('tts'), beforeManual + 1, 'accepted replay bypasses mutable planning without a second POST')
    } finally {
      await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    }

    const changedReplay = await request(app).post(`/api/projects/${project.slug}/generate/audio`)
      .send({ ...manualBody(manualAction), speed: 1.1 })
    assert.equal(changedReplay.status, 409, JSON.stringify(changedReplay.body))
    assert.equal(service.providerSubmissionCount('tts'), beforeManual + 1, 'changed-body replay cannot submit')
    const overwriteOverride = await request(app).post(`/api/projects/${project.slug}/generate/audio`)
      .send({
        ...manualBody('77777777-7777-4777-8777-777777777777'),
        no_overwrite: false,
      })
    assert.equal(overwriteOverride.status, 400, JSON.stringify(overwriteOverride.body))
    assert.equal(service.providerSubmissionCount('tts'), beforeManual + 1, 'Regenerate cannot use manual redo')

    // Scoped chapter checks intentionally run before any full Audio Assembly.
    const fullBeforeAssembly = await request(app).post(`/api/projects/${project.slug}/video-editor/subtitles/transcribe/${episodeId}`)
      .send({ model: 'mock-whisper-v1', per_chapter: true, force: false })
    assert.equal(fullBeforeAssembly.status, 409)
    assert.equal(service.providerSubmissionCount('transcription'), 0)
    const unknownChapter = await request(app).post(`/api/projects/${project.slug}/video-editor/subtitles/transcribe/${episodeId}`)
      .send({ model: 'mock-whisper-v1', per_chapter: true, sections: ['Chapter_99'] })
    assert.equal(unknownChapter.status, 409)
    assert.equal(service.providerSubmissionCount('transcription'), 0)

    const subtitleBody = (operationId?: string, force = true) => ({
      model: 'mock-whisper-v1', language: 'en', force, per_chapter: true, sections: ['Chapter_01'],
      ...(operationId ? { operation_id: operationId } : {}),
    })
    const subtitleAction = '33333333-3333-4333-8333-333333333333'
    service.queueScenario('transcription', { states: ['accepted', 'failed'], failureCode: 'provider_error', finalCredits: 3 })
    const [subtitleFirst, subtitleReplay] = await Promise.all([
      request(app).post(`/api/projects/${project.slug}/video-editor/subtitles/transcribe/${episodeId}`).send(subtitleBody(subtitleAction)),
      request(app).post(`/api/projects/${project.slug}/video-editor/subtitles/transcribe/${episodeId}`).send(subtitleBody(subtitleAction)),
    ])
    sameJob(subtitleFirst, subtitleReplay, 'subtitle HTTP replay')
    await terminal(jobId(subtitleFirst), 'first subtitle action to settle')
    assert.equal(service.providerSubmissionCount('transcription'), 1, 'one subtitle action made one provider POST')

    const subtitleRetry = await request(app).post(`/api/projects/${project.slug}/jobs/${jobId(subtitleFirst)}/retry`)
    assert.equal(subtitleRetry.status, 202, JSON.stringify(subtitleRetry.body))
    const recoveredSubtitle = (await jq.getJobs(project.slug)).find(job =>
      job.type === 'subtitles_transcribe'
      && job.job_id !== jobId(subtitleFirst)
      && job.params.generation_action?.id === subtitleAction,
    )
    assert.ok(recoveredSubtitle, 'subtitle Jobs Retry created an action-preserving recovery job')
    await terminal(recoveredSubtitle.job_id, 'subtitle Jobs Retry to settle')
    assert.equal(service.providerSubmissionCount('transcription'), 1, 'subtitle Jobs Retry replayed the first action key')

    service.queueScenario('transcription', { states: ['accepted', 'succeeded'] })
    const subtitleNew = await request(app).post(`/api/projects/${project.slug}/video-editor/subtitles/transcribe/${episodeId}`)
      .send(subtitleBody('44444444-4444-4444-8444-444444444444'))
    assert.equal(subtitleNew.status, 201, JSON.stringify(subtitleNew.body))
    await terminal(jobId(subtitleNew), 'second subtitle action to settle')
    assert.equal(service.providerSubmissionCount('transcription'), 2, 'a later subtitle action made one intentionally fresh POST')
    const subtitleOrdinary = await request(app).post(`/api/projects/${project.slug}/video-editor/subtitles/transcribe/${episodeId}`)
      .send(subtitleBody(undefined, false))
    assert.equal(subtitleOrdinary.status, 201, JSON.stringify(subtitleOrdinary.body))
    await terminal(jobId(subtitleOrdinary), 'ordinary subtitle recovery to settle')
    assert.equal(service.providerSubmissionCount('transcription'), 2, 'ordinary subtitle recovery kept its current output')
    assert.equal(jq.getJob(jobId(subtitleOrdinary))?.params.generation_action, undefined, 'ordinary subtitle recovery stays unmarked')
  } finally {
    stopObservingPumps?.()
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?._waitForJobPersistenceForTesting()
    await service.close()
    await isolated.cleanup()
  }
})
