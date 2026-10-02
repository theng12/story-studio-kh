import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitForValue } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
  'base64',
)

test('a batch generator stops claiming items after the first credit refusal', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const settings = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { clearGenStudioCatalogCache, isGenStudioInsufficientCredits } = await import('../lib/genstudio-client.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    await import('../providers/video/genstudio.js')
    const { generateAiVideo } = await import('../generators/ai-video.js')

    const project = await pm.createProject({ name: 'Batch credit floor', episode_prefix: 'EP', episode_digits: 3 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Credit floor clips', logline: 'A test.', themes: [],
      suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
    }], 'mock-chat-v1')
    assert.ok(idea)
    const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
    const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
    await fs.mkdir(paths.bg_dir, { recursive: true })
    await fs.writeFile(path.join(paths.bg_dir, `${accepted.episode_code}_Scene01_v1.png`), ONE_PIXEL_PNG)
    await fs.writeFile(path.join(paths.bg_dir, `${accepted.episode_code}_Scene02_v1.png`), ONE_PIXEL_PNG)
    await fs.writeFile(path.join(paths.bg_dir, `${accepted.episode_code}_Scene03_v1.png`), ONE_PIXEL_PNG)
    await fs.writeFile(path.join(paths.bg_dir, `${accepted.episode_code}_Scene04_v1.png`), ONE_PIXEL_PNG)

    await settings.setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    clearGenStudioCatalogCache()
    service.queueScenario('video', { states: ['accepted', 'running', 'succeeded'], submitDelayMs: 150 })
    service.queueScenario('video', { states: ['accepted', 'running', 'succeeded'], submitDelayMs: 150 })

    let videoPosts = 0
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (url.origin === service.baseUrl && url.pathname === '/v1/videos/generations' && method === 'POST') {
        videoPosts++
        if (videoPosts === 1) {
          // Hold the first refusal until the other two live admission slots
          // have reached the provider.  Without this condition the assertion
          // races the generator's model-catalogue reads and sometimes rejects
          // before those already-admitted siblings have submitted.
          await waitForValue(
            () => videoPosts >= 3,
            { label: 'three admitted video submissions', timeoutMs: 2_000 },
          )
          return Response.json({ detail: 'Insufficient credits' }, { status: 402 })
        }
      }
      const response = await originalFetch(input, init)
      if (url.origin !== service.baseUrl || !['/v1/video/models', '/v1/videos/models'].includes(url.pathname)) return response
      const models = await response.json() as Array<Record<string, unknown>>
      return Response.json(models.map(model => ({ ...model, available: true })))
    }

    const job: any = {
      job_id: 'batch-credit-floor-job',
      project_slug: project.slug,
      episode_id: accepted.episode_code,
      type: 'ai_video_generate',
      title: 'AI Video',
      status: 'running',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {
        model: 'mock-video-v1',
        mode: 'frames',
        prompt_source: 'manual',
        manual_prompts: ['First clip.', 'Second clip.', 'Third clip.', 'Fourth clip.'],
        number_of_videos_per_prompt: 1,
        aspect_ratio: 'landscape',
        duration_seconds: 5,
        resolution: '720p',
        force: false,
      },
    }

    await assert.rejects(generateAiVideo(job), error => isGenStudioInsufficientCredits(error))
    assert.equal(videoPosts, 3, 'only the three already-admitted requests may reach the Gateway; the fourth stays local')
    assert.equal(job.output_lines.some((line: string) => line.includes('Failed:')), false)
    const saved = await fs.readdir(paths.video_dir)
    assert.equal(saved.filter(filename => filename.endsWith('.mp4')).length, 2, 'already accepted siblings must settle and save before the batch ends')
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})
