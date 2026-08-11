import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { generateAudio } = await import('../generators/audio.js')
const pm = await import('../services/project-manager.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')

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

void test('audio generation fans out from the selected model\'s live published hint', async () => {
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
  } finally {
    clearGenStudioCatalogCache()
    if (previousOverride === undefined) delete process.env.STORY_STUDIO_TTS_CONCURRENCY
    else process.env.STORY_STUDIO_TTS_CONCURRENCY = previousOverride
    await service.close()
    await temp.cleanup()
  }
})
