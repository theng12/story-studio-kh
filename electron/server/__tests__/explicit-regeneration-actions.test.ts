/** Explicit paid actions keep one provider identity across Retry, but never
 * borrow a previous action's completed request. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { readManualGenerationRedoIntent, stampFreshGenerationAction } from '../lib/fresh-generation-action.js'

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function source(relative: string): Promise<string> {
  return readFile(path.join(server, relative), 'utf8')
}

test('manual generation redo accepts one strict client intent and fingerprints stable server metadata', () => {
  assert.deepEqual(readManualGenerationRedoIntent({
    manual_redo: { intent: 'replace_unresolved', source_job_id: 'source-job' },
  }), { intent: 'replace_unresolved', source_job_id: 'source-job' })
  assert.equal(readManualGenerationRedoIntent({}), null)
  for (const manual_redo of [
    {},
    { intent: 'replace_unresolved' },
    { intent: 'other', source_job_id: 'source-job' },
    { intent: 'replace_unresolved', source_job_id: 'source-job', target: [10] },
  ]) assert.throws(() => readManualGenerationRedoIntent({ manual_redo }), /manual_redo/)

  const operationId = '11111111-1111-4111-8111-111111111111'
  const base = {
    model: 'writer',
    manual_redo: {
      version: 1, intent: 'replace_unresolved', source_job_id: 'source-job',
      requested_at: '2026-10-13T00:00:00.000Z', target_chapters: [10, 11], selected_model_id: 'writer',
    },
  }
  const a = stampFreshGenerationAction(base, operationId)
  const b = stampFreshGenerationAction({
    ...base,
    manual_redo: { ...base.manual_redo, requested_at: '2026-10-14T00:00:00.000Z' },
  }, operationId)
  assert.equal(a.generation_action_fingerprint, b.generation_action_fingerprint)
})

test('per-scene image re-roll preserves the caller operation identity through route replay and provider keying', async () => {
  const [route, generator] = await Promise.all([
    source('routes/scene-review.ts'),
    source('generators/scene-image.ts'),
  ])

  assert.match(route, /generate-image[\s\S]{0,2200}?operation_id/,
    'a lost POST needs a caller correlation id, not a server-random replacement')
  assert.match(route, /generation_action:\s*\{\s*id:\s*operationId,\s*kind:\s*'fresh'\s*\}/,
    'client-provided action fields must be discarded in favour of one normalized server record')
  assert.match(generator, /generation_action\?: \{ id\?: string; kind\?: string \}/)
  assert.match(generator, /params\.generation_action\?\.kind === 'fresh'/)
  assert.match(generator, /scene:\$\{scene_id\}:image\$\{actionId \? `:fresh:\$\{actionId\}` : ''\}/,
    'the attempt identity must participate in the provider idempotency key')
})

test('music top-up preserves a caller operation identity through route replay and provider request keying', async () => {
  const [route, generator] = await Promise.all([
    source('routes/music-library.ts'),
    source('generators/music-generate.ts'),
  ])

  assert.match(route, /operation_id/,
    'a lost POST needs a caller correlation id, not a server-random replacement')
  assert.match(route, /generation_action:\s*\{\s*id:\s*operationId,\s*kind:\s*'fresh'\s*\}/,
    'client-provided action fields must be discarded in favour of one normalized server record')
  assert.match(route, /brief_id:\s*operationId/,
    'queue retry only preserves params; the original top-up must stamp its own action identity')
  assert.match(generator, /const briefId = params\.brief_id \|\|/,
    'the persisted action identity, not a successor queue job id, must form the provider key')
})

test('Images board force re-render uses the durable action id while ordinary recovery keeps its existing scope', async () => {
  const [route, generator] = await Promise.all([
    source('routes/images.ts'),
    source('generators/images.ts'),
  ])

  assert.match(route, /req\.body\.force[\s\S]{0,1000}?operation_id/,
    'only the explicit force path needs the caller correlation id')
  assert.match(route, /generation_action:\s*\{\s*id:\s*operationId,\s*kind:\s*'fresh'\s*\}/)
  assert.match(generator, /const generationAction = [\s\S]{0,160}?generation_action/)
  assert.match(generator, /const generationActionId = generationAction\?\.kind === 'fresh'/)
  assert.match(generator, /force && generationActionId \? baseScope : resolveImageRetryScope/,
    'a forced action retry must not silently promote a second provider identity')
  assert.match(generator, /force \? `force:\$\{generationActionId \|\| job\.job_id\}` : 'default'/,
    'non-force recovery must remain default while force Retry keeps the original action key')
})

void test('image and music routes retain one paid provider request per operation across HTTP replay and Jobs Retry', async () => {
  const isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const service = await startMockGenStudioService()
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()

    const project = await pm.createProject({ name: 'Explicit regeneration route fixture', episode_prefix: 'EP', episode_digits: 4 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Route identity fixture', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    }], 'mock-chat-v1')
    const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
    const episodeId = accepted.episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
    await fs.mkdir(paths.thumb_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.thumb_prompts_dir, `${episodeId}_Thumbnail_Prompts.md`),
      '# Thumbnail Prompts\n\n## Thumbnail 1: Lantern\n\nA lantern in a quiet archive.\n')

    const terminal = async (jobId: string, label: string) => {
      try {
        await waitFor(() => {
          const status = jq.getJob(jobId)?.status
          // The queue refuses Retry/enqueue while the previous executor is still
          // unwinding (job-queue.ts assertNoSettlingWorker): a terminal row is not
          // yet an admission window. Wait for the owned worker slot too, exactly as
          // pipeline-explicit-regeneration's terminal helper does.
          return (status === 'done' || status === 'error' || status === 'cancelled')
            && !jq._isJobWorkerActiveForTesting(jobId)
        }, { label, timeoutMs: 10_000 })
      } catch (error) {
        const current = jq.getJob(jobId)
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nCurrent job: ${JSON.stringify({
          job_id: current?.job_id,
          status: current?.status,
          error: current?.error,
          output_lines: current?.output_lines,
          item_progress: current?.item_progress,
        })}`)
      }
    }

    const imageBody = (operationId: string, force = true) => ({
      episode_id: episodeId, model: 'mock-image-v1', mode: 'thumbs', aspect_ratio: '16:9', force,
      ...(force ? { thumb_number: 1, operation_id: operationId } : {}),
    })
    const imageAction = '11111111-1111-4111-8111-111111111111'
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'provider_error' })
    const [imageFirst, imageReplay] = await Promise.all([
      request(app).post(`/api/projects/${project.slug}/generate/images`).send(imageBody(imageAction)),
      request(app).post(`/api/projects/${project.slug}/generate/images`).send(imageBody(imageAction)),
    ])
    assert.equal(imageFirst.status, 201, JSON.stringify(imageFirst.body))
    assert.equal(imageReplay.status, 201, JSON.stringify(imageReplay.body))
    assert.equal(imageFirst.body.job_id, imageReplay.body.job_id, 'same HTTP action rejoined one queue owner')
    await terminal(imageFirst.body.job_id, 'first image action to settle')
    assert.equal(service.providerSubmissionCount('image'), 1, 'same action made one image provider POST')

    const imageMismatch = await request(app).post(`/api/projects/${project.slug}/generate/images`).send({
      ...imageBody(imageAction), extra_details: 'different thumbnail framing',
    })
    assert.equal(imageMismatch.status, 409, 'a terminal action cannot be reused with a different request scope')
    assert.equal(service.providerSubmissionCount('image'), 1, 'the mismatched action made no provider POST')

    const imageRetry = await request(app).post(`/api/projects/${project.slug}/jobs/${imageFirst.body.job_id}/retry`)
    assert.equal(imageRetry.status, 202, JSON.stringify(imageRetry.body))
    await terminal(imageRetry.body.job.job_id, 'image Jobs Retry to settle')
    assert.equal(service.providerSubmissionCount('image'), 1, 'Jobs Retry replayed the original failed image provider key')

    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    const imageNew = await request(app).post(`/api/projects/${project.slug}/generate/images`).send(imageBody('22222222-2222-4222-8222-222222222222'))
    assert.equal(imageNew.status, 201, JSON.stringify(imageNew.body))
    await terminal(imageNew.body.job_id, 'new image action to settle')
    assert.equal(service.providerSubmissionCount('image'), 2, 'a distinct image action made one fresh provider POST')

    const imageRecover = await request(app).post(`/api/projects/${project.slug}/generate/images`).send(imageBody('', false))
    assert.equal(imageRecover.status, 201, JSON.stringify(imageRecover.body))
    await terminal(imageRecover.body.job_id, 'ordinary image recovery to settle')
    assert.equal(service.providerSubmissionCount('image'), 2, 'ordinary recovery kept its existing artifact and bought nothing')

    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
      // 1.4.288 — a plan is done only when its scenes reach the end of the 3 s narration below.
      scenes: [{ id: 'scene-001', scene_index: 1, start_sec: 0, end_sec: 3, visual_prompt: 'A lantern in a quiet archive.' }],
    }))
    await Promise.all([paths.audio_dir, paths.subtitles_dir, paths.merged_audio_dir, paths.script_dir].map(dir => fs.mkdir(dir, { recursive: true })))
    await fs.writeFile(paths.narration_docx, [
      '## Chapter 01: Fixture', '', 'Narration for Chapter_01.', '',
      '## Chapter 02: Fixture', '', 'Narration for Chapter_02.', '',
    ].join('\n'))
    const chapterOne = `${episodeId}_Chapter_01.mp3`
    const chapterTwo = `${episodeId}_Chapter_02.mp3`
    const writeTone = (output: string, duration: number) => runFfmpeg([
      '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
      '-codec:a', 'libmp3lame', '-q:a', '9', output,
    ])
    await writeTone(path.join(paths.audio_dir, chapterOne), 1)
    await writeTone(path.join(paths.audio_dir, chapterTwo), 1)
    await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ gap_duration_s: 1, sections: [
      { slug: 'Chapter_01', duration_s: 1, source_file: chapterOne },
      { slug: 'Chapter_02', duration_s: 1, source_file: chapterTwo },
    ] }))
    const mergedPath = path.join(paths.merged_audio_dir, `${episodeId}_merged_audio.mp3`)
    await writeTone(mergedPath, 3)
    const merged = await fs.stat(mergedPath)
    await fs.writeFile(path.join(paths.merged_audio_dir, `${episodeId}_merged_audio.completion.json`), JSON.stringify({
      output_filename: `${episodeId}_merged_audio.mp3`, bytes: merged.size, duration_sec: 3,
      opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
    }))
    await fs.writeFile(path.join(paths.subtitles_dir, `${episodeId}_Chapter_01.srt`), '1\n00:00:00,000 --> 00:00:01,000\nFixture one\n')
    await fs.writeFile(path.join(paths.subtitles_dir, `${episodeId}_Chapter_02.srt`), '1\n00:00:00,000 --> 00:00:01,000\nFixture two\n')
    const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
    await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:02,000\nFixture\n')
    await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
    // This channel keeps Scene Review approval manual. Since 2026-10-25 a channel with no
    // saved choice auto-approves (owner), which would approve scene-001 and leave the
    // continuity Retry below nothing to recover.
    await pm.updateConfig(project.slug, {
      scene_review_genstudio_presets: [{ id: 'manual', name: 'Manual approval', type: 'scene-review', data: { auto_approve_generated: false } }],
      'scene_review_genstudio_last_preset_scene-review': 'manual',
    } as any)
    const sceneAction = '55555555-5555-4555-8555-555555555555'
    const sceneBody = (autoApprove: boolean) => ({
      scene_id: 'scene-001', model: 'mock-image-v1', aspect_ratio: '16:9',
      operation_id: sceneAction, auto_approve_generated: autoApprove,
    })
    const sceneFirst = await request(app).post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-image`).send(sceneBody(false))
    assert.equal(sceneFirst.status, 201, JSON.stringify(sceneFirst.body))
    const sceneMismatch = await request(app).post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-image`).send(sceneBody(true))
    assert.equal(sceneMismatch.status, 409, 'approval behavior is part of a Scene Review action scope')
    await terminal(sceneFirst.body.job_id, 'scene image action to settle')

    const continuityBody = (operationId: string, autoApprove = false) => ({
      single_scene_id: 'scene-001', model: 'mock-image-v1', aspect_ratio: '16:9', force: true,
      operation_id: operationId, auto_approve_generated: autoApprove,
    })
    const continuityAction = '66666666-6666-4666-8666-666666666666'
    const continuityBefore = service.providerSubmissionCount('image')
    const releasedJobIds = new Set<string>()
    // A terminal status is published before runJob's finally block releases
    // the shared image slot. Observe the release before queuing its successor.
    const stopObservingPumps = jq._observeQueuePumpsForTesting((_type, releasedJobId) => {
      if (releasedJobId) releasedJobIds.add(releasedJobId)
    })
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'provider_error' })
    try {
      const [continuityFirst, continuityReplay] = await Promise.all([
        request(app).post(`/api/projects/${project.slug}/scene-review/${episodeId}/continuity-render`).send(continuityBody(continuityAction)),
        request(app).post(`/api/projects/${project.slug}/scene-review/${episodeId}/continuity-render`).send(continuityBody(continuityAction)),
      ])
      assert.equal(continuityFirst.status, 201, JSON.stringify(continuityFirst.body))
      assert.equal(continuityReplay.status, 201, JSON.stringify(continuityReplay.body))
      assert.equal(continuityFirst.body.job_id, continuityReplay.body.job_id, 'same continuity action rejoined one queue owner')
      const continuityMismatch = await request(app).post(`/api/projects/${project.slug}/scene-review/${episodeId}/continuity-render`).send(continuityBody(continuityAction, true))
      assert.equal(continuityMismatch.status, 409, 'approval behavior is part of a Scene Review action scope')
      await terminal(continuityFirst.body.job_id, 'first continuity action to settle')
      assert.equal(service.providerSubmissionCount('image'), continuityBefore + 1, 'same continuity action made one image provider POST')
      await waitFor(() => releasedJobIds.has(continuityFirst.body.job_id), {
        label: 'terminal continuity action to release its shared image slot', timeoutMs: 10_000,
      })
      // The observer is already active: a fast mocked executor may release its
      // slot before the HTTP response hands this test the successor id.
      const continuityRetry = await request(app).post(`/api/projects/${project.slug}/jobs/${continuityFirst.body.job_id}/retry`)
      assert.equal(continuityRetry.status, 202, JSON.stringify(continuityRetry.body))
      const recoveryPlan = continuityRetry.body.plan
      const continuityStep = recoveryPlan?.steps?.continuity_render
      const continuityRecoveryJobId = continuityStep?.job_id
      const recoveryJob = typeof continuityRecoveryJobId === 'string' ? jq.getJob(continuityRecoveryJobId) : undefined
      assert.ok(
        typeof continuityRecoveryJobId === 'string'
          && continuityRecoveryJobId.length > 0
          && recoveryJob?.job_id === continuityRecoveryJobId
          && recoveryJob.project_slug === project.slug
          && recoveryJob.episode_id === episodeId,
        `continuity Jobs Retry did not dispatch its recovery edge: ${JSON.stringify({
          dispatch_status: recoveryPlan?.dispatch_status,
          dispatch_job_id: recoveryPlan?.dispatch_job_id,
          first_unresolved: recoveryPlan?.first_unresolved,
          message: recoveryPlan?.message,
          completed: recoveryPlan?.completed,
          steps: recoveryPlan?.steps,
          source_job: jq.getJob(continuityFirst.body.job_id),
        })}`,
      )
      assert.notEqual(continuityRecoveryJobId, continuityFirst.body.job_id,
        'episode recovery creates a successor queue record only after preserving the paid action identity')
      assert.equal(continuityRetry.body.plan.steps.continuity_render.params.generation_action.id, continuityAction,
        'episode recovery preserves the explicit provider action identity')
      await terminal(continuityRecoveryJobId, 'continuity Jobs Retry to settle')
      assert.equal(service.providerSubmissionCount('image'), continuityBefore + 1,
        `continuity Jobs Retry replayed the original provider key: ${JSON.stringify({
          submissions: service.submissions.filter(row => row.operation === 'image').slice(-3),
          job: jq.getJob(continuityRecoveryJobId),
        })}`)
      await waitFor(() => releasedJobIds.has(continuityRecoveryJobId), {
        label: 'retried continuity action to release its shared image slot', timeoutMs: 10_000,
      })
    } finally {
      stopObservingPumps()
    }

    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    const continuityNew = await request(app).post(`/api/projects/${project.slug}/scene-review/${episodeId}/continuity-render`).send(
      continuityBody('77777777-7777-4777-8777-777777777777'),
    )
    assert.equal(continuityNew.status, 201, JSON.stringify(continuityNew.body))
    await terminal(continuityNew.body.job_id, 'new continuity action to settle')
    assert.equal(service.providerSubmissionCount('image'), continuityBefore + 2, 'a distinct continuity action made one fresh provider POST')

    const musicBody = (operationId: string) => ({
      brief: 'warm instrumental lo-fi for reading', count: 1, model: 'mock-music-v1', instrumental: true, operation_id: operationId,
    })
    const musicAction = '33333333-3333-4333-8333-333333333333'
    service.queueScenario('music', { states: ['accepted', 'failed'], failureCode: 'provider_error' })
    const [musicFirst, musicReplay] = await Promise.all([
      request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(musicBody(musicAction)),
      request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(musicBody(musicAction)),
    ])
    assert.equal(musicFirst.status, 201, JSON.stringify(musicFirst.body))
    assert.equal(musicReplay.status, 201, JSON.stringify(musicReplay.body))
    assert.equal(musicFirst.body.job_id, musicReplay.body.job_id, 'same HTTP music action rejoined one queue owner')
    await terminal(musicFirst.body.job_id, 'first music action to settle')
    assert.equal(service.providerSubmissionCount('music'), 1, 'same music action made one provider POST')

    const musicMismatch = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send({
      ...musicBody(musicAction), brief: 'different music brief',
    })
    assert.equal(musicMismatch.status, 409, 'a terminal music action cannot be reused with a different request scope')
    assert.equal(service.providerSubmissionCount('music'), 1, 'the mismatched music action made no provider POST')

    const musicRetry = await request(app).post(`/api/projects/${project.slug}/jobs/${musicFirst.body.job_id}/retry`)
    assert.equal(musicRetry.status, 202, JSON.stringify(musicRetry.body))
    await terminal(musicRetry.body.job.job_id, 'music Jobs Retry to settle')
    assert.equal(service.providerSubmissionCount('music'), 1, 'Jobs Retry replayed the original failed music provider key')

    service.queueScenario('music', { states: ['accepted', 'succeeded'] })
    const musicNew = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(musicBody('44444444-4444-4444-8444-444444444444'))
    assert.equal(musicNew.status, 201, JSON.stringify(musicNew.body))
    await terminal(musicNew.body.job_id, 'new music action to settle')
    assert.equal(service.providerSubmissionCount('music'), 2, 'a distinct music action made one fresh provider POST')
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?._waitForJobPersistenceForTesting()
    await service.close()
    await isolated.cleanup()
  }
})
