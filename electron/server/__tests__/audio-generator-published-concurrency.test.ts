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
