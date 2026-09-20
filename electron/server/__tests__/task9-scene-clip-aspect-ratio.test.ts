import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { generateSceneClipJob } from '../generators/scene-clip.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'

async function createClipFixture(name: string, aspectRatio?: string) {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')

  service.setVideoModels([{
    id: 'mock-video-nonbinary-ratio',
    display_name: 'Mock Video Nonbinary Ratio',
    available: true,
    modes: ['image-to-video'],
    aspect_ratios: ['1:1', '4:3'],
    variants: [{
      operation: 'image-to-video',
      duration_seconds: 1,
      resolution: '720p',
      credits_per_video: 10,
      minimum_credits: 10,
      price_version: 'mock-ratio-v1',
    }],
  }])
  service.queueScenario('video', { videoArtifact: tinyVideoBytes() })
  await settings.setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()

  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: name,
    logline: 'Disposable M01 aspect-ratio fixture.',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  const imagePath = path.join(paths.episode_dir, 'scene-ratio-source.png')
  await fs.writeFile(imagePath, Buffer.from('disposable-scene-image'))
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [{
    id: 'scene-ratio',
    scene_index: 1,
    image_path: imagePath,
    motion_prompt: 'A square archive door opens slowly.',
    motion_choice: 'clip',
  }] }))

  const now = new Date().toISOString()
  return {
    temp,
    service,
    job: {
      job_id: `m01-${Math.random().toString(16).slice(2)}`,
      project_slug: project.slug,
      episode_id: episodeId,
      type: 'scene_clip_generate',
      title: 'M01 aspect-ratio test',
      status: 'running',
      created_at: now,
      started_at: now,
      finished_at: null,
      error: null,
      output_lines: [],
      progress: 0,
      params: {
        episode_id: episodeId,
        scene_id: 'scene-ratio',
        model: 'mock-video-nonbinary-ratio',
        ...(aspectRatio === undefined ? {} : { aspect_ratio: aspectRatio }),
        operation: 'image-to-video',
        duration_seconds: 1,
        resolution: '720p',
      },
    } as any,
  }
}

test('a published nonbinary scene-clip aspect ratio reaches the fake provider unchanged', async () => {
  const fixture = await createClipFixture('Published 4 by 3 clip ratio', '4:3')
  try {
    await generateSceneClipJob(fixture.job)

    const submissions = fixture.service.submissions.filter(entry => entry.operation === 'video' && !entry.replay)
    assert.equal(submissions.length, 1)
    assert.equal(submissions[0]?.parsedBody?.aspect_ratio, '4:3')
  } finally {
    await fixture.service.close()
    await fixture.temp.cleanup()
  }
})

test('an unpublished scene-clip aspect ratio fails before a paid fake-provider submission', async () => {
  const fixture = await createClipFixture('Unpublished clip ratio', '3:2')
  try {
    await assert.rejects(
      () => generateSceneClipJob(fixture.job),
      /does not publish.*3:2|3:2.*not published/i,
    )
    assert.equal(fixture.service.providerSubmissionCount('video'), 0)
  } finally {
    await fixture.service.close()
    await fixture.temp.cleanup()
  }
})

test('a historical scene-clip job with no ratio fails when the catalogue publishes no default', async () => {
  const fixture = await createClipFixture('Missing clip ratio')
  try {
    await assert.rejects(
      () => generateSceneClipJob(fixture.job),
      /aspect ratio.*required|publishes no default.*aspect ratio/i,
    )
    assert.equal(fixture.service.providerSubmissionCount('video'), 0)
  } finally {
    await fixture.service.close()
    await fixture.temp.cleanup()
  }
})
