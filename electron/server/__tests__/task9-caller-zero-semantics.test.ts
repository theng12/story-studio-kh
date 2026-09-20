import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const YOUTUBE_CHANNEL = 'UC-task9-zero-semantics'

function job(projectSlug: string, episodeId: string, type: string, params: Record<string, unknown>): any {
  const now = new Date().toISOString()
  return {
    job_id: `${type}-${Math.random().toString(16).slice(2)}`,
    project_slug: projectSlug,
    episode_id: episodeId,
    type,
    title: 'Task 9 zero semantics',
    status: 'running',
    created_at: now,
    started_at: now,
    finished_at: null,
    output_lines: [],
    progress: 0,
    params,
  }
}

async function createEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: name,
    logline: 'Disposable Task 9 fixture.',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  return {
    project,
    episodeId: accepted.episode_code,
    paths: await resolveEpisodePathsByCode(project.slug, accepted.episode_code),
  }
}

async function writeScenePlan(
  paths: { scene_prompts_dir: string; subtitles_dir: string },
  episodeId: string,
  scenes: Array<Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nTask 9 fixture\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
}

async function configureMockGenStudio(baseUrl: string): Promise<void> {
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
  await import('../providers/image/genstudio.js')
}

async function configureYouTubeEpisode(name: string) {
  const fixture = await createEpisode(name)
  const { configureYouTubeApplication, assignProjectYouTubeChannel } = await import('../services/youtube-connection-store.js')
  const { resolveYouTubeCredential } = await import('../services/youtube-credential.js')
  await configureYouTubeApplication({ client_id: 'task9-client', client_secret: 'task9-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: YOUTUBE_CHANNEL, title: 'Task 9 Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'task9-access', refresh_token: 'task9-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await assignProjectYouTubeChannel({
    project_slug: fixture.project.slug,
    channel_id: YOUTUBE_CHANNEL,
    expected_previous_channel_id: null,
  })
  const credential = await resolveYouTubeCredential(fixture.project.slug)
  assert.ok(credential)
  return { ...fixture, credential }
}

async function writeUploadSidecar(
  episodeDir: string,
  accountId: string,
  thumbnailSet: boolean,
): Promise<string> {
  const sidecarPath = path.join(episodeDir, 'youtube_upload.json')
  const now = new Date().toISOString()
  await fs.writeFile(sidecarPath, JSON.stringify({
    platform: 'youtube',
    video_id: 'video-task9',
    account_id: accountId,
    channel_id: YOUTUBE_CHANNEL,
    uploaded_at: now,
    last_sync_at: now,
    scheduled_for: null,
    privacy_status: 'private',
    title: 'Task 9 fixture',
    description: '',
    tags: [],
    thumbnail_set: thumbnailSet,
    deleted_at: null,
  }))
  return sidecarPath
}

test('an explicit thumbnail selector missing from a valid prompt file fails before provider work', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    const { generateImages } = await import('../generators/images.js')
    const { project, episodeId, paths } = await createEpisode('Missing thumbnail selector')
    await fs.mkdir(paths.thumb_prompts_dir, { recursive: true })
    await fs.writeFile(
      path.join(paths.thumb_prompts_dir, `${episodeId}_Thumbnail_Prompts.md`),
      '# Thumbnail Prompts\n\n## Thumbnail 1: Lantern\n\nA lantern in a quiet archive.\n',
    )
    const run = job(project.slug, episodeId, 'thumb_images', {
      episode_id: episodeId,
      mode: 'thumbs',
      model: 'mock-image-v1',
      aspect_ratio: '16:9',
      resolution: '1K',
      thumb_number: 999,
    })

    await assert.rejects(
      () => generateImages(run),
      /thumbnail (?:prompt )?999.*(?:not found|does not exist)|(?:not found|does not exist).*thumbnail (?:prompt )?999/i,
    )
    assert.equal(service.providerSubmissionCount('image'), 0)
    assert.doesNotMatch(run.output_lines.join('\n'), /All images generated successfully/)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('an explicit scene selector missing from a valid prompt file fails before provider work', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    const { generateImages } = await import('../generators/images.js')
    const { project, episodeId, paths } = await createEpisode('Missing scene selector')
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(
      path.join(paths.scene_prompts_dir, `${episodeId}_Scene_Prompts.md`),
      '# Scene Prompts\n\n## Scene 1: Lantern\n\nA lantern in a quiet archive.\n',
    )
    const run = job(project.slug, episodeId, 'scene_images', {
      episode_id: episodeId,
      mode: 'scenes',
      model: 'mock-image-v1',
      aspect_ratio: '16:9',
      resolution: '1K',
      scene_number: 999,
    })

    await assert.rejects(
      () => generateImages(run),
      /scene prompt 999.*(?:not found|does not exist)|(?:not found|does not exist).*scene prompt 999/i,
    )
    assert.equal(service.providerSubmissionCount('image'), 0)
    assert.doesNotMatch(run.output_lines.join('\n'), /All images generated successfully/)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('an unknown continuity batch scene ID fails before provider work', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const { project, episodeId, paths } = await createEpisode('Unknown continuity target')
    await writeScenePlan(paths, episodeId, [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'A lantern in a quiet archive.' },
    ])
    const run = job(project.slug, episodeId, 'continuity_render', {
      episode_id: episodeId,
      model: 'mock-image-v1',
      aspect_ratio: '16:9',
      resolution: '1K',
      scene_ids: ['scene-missing'],
      missing_only: true,
    })

    await assert.rejects(
      () => runContinuityRenderJob(run),
      /scene-missing.*(?:not found|unknown)|(?:not found|unknown).*scene-missing/i,
    )
    assert.equal(service.providerSubmissionCount('image'), 0)
    assert.doesNotMatch(run.output_lines.join('\n'), /Done — 0\/0/)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('known continuity targets that are already current remain a valid zero-item completion', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { project, episodeId, paths } = await createEpisode('Current continuity target')
    await writeScenePlan(paths, episodeId, [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'A lantern in a quiet archive.' },
    ])
    const imagesDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(imagesDir, { recursive: true })
    await sharp({ create: { width: 3, height: 3, channels: 3, background: '#123456' } })
      .png().toFile(path.join(imagesDir, 'scene-001.png'))
    const run = job(project.slug, episodeId, 'continuity_render', {
      episode_id: episodeId,
      model: 'mock-image-v1',
      aspect_ratio: '16:9',
      resolution: '1K',
      scene_ids: ['scene-001'],
      missing_only: true,
    })

    await runContinuityRenderJob(run)

    assert.equal(run.result?.complete, true)
    assert.equal(run.result?.completion?.expected, 0)
    assert.equal(service.providerSubmissionCount('image'), 0)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('an empty Scene Plan cannot complete a clip batch as zero of zero', async () => {
  const temp = await useTempDataDir()
  try {
    const { generateSceneClipsBatchJob } = await import('../generators/scene-clip.js')
    const { project, episodeId, paths } = await createEpisode('Empty clip plan')
    await writeScenePlan(paths, episodeId, [])
    const run = job(project.slug, episodeId, 'scene_clips_batch', {
      episode_id: episodeId,
      model: 'mock-video-v1',
    })

    await assert.rejects(() => generateSceneClipsBatchJob(run), /scene(?:_| )plan.*has no scenes/i)
  } finally {
    await temp.cleanup()
  }
})

test('a nonempty all-Still Scene Plan remains a valid zero-item clip completion', async () => {
  const temp = await useTempDataDir()
  try {
    const { generateSceneClipsBatchJob } = await import('../generators/scene-clip.js')
    const { project, episodeId, paths } = await createEpisode('All Still clip plan')
    await writeScenePlan(paths, episodeId, [{
      id: 'scene-still',
      scene_index: 1,
      visual_prompt: 'A still archive.',
      motion_prompt: '',
      motion_choice: 'still',
    }])
    const run = job(project.slug, episodeId, 'scene_clips_batch', {
      episode_id: episodeId,
      model: 'mock-video-v1',
    })

    await generateSceneClipsBatchJob(run)

    assert.equal(run.result?.complete, true)
    assert.equal(run.result?.completion?.expected, 0)
  } finally {
    await temp.cleanup()
  }
})

test('a malformed upload sidecar is an enumeration failure, not an empty thumbnail backfill', async () => {
  const temp = await useTempDataDir()
  try {
    const { generateThumbnailRefresh } = await import('../generators/youtube-thumbnail-refresh.js')
    const { project, episodeId, paths } = await configureYouTubeEpisode('Malformed thumbnail sidecar')
    await fs.writeFile(path.join(paths.episode_dir, 'youtube_upload.json'), '{not-json')
    const run = job(project.slug, episodeId, 'youtube_thumbnail_refresh', { mode: 'missing' })

    await assert.rejects(
      () => generateThumbnailRefresh(run),
      new RegExp(`${episodeId}.*youtube_upload\\.json.*(?:unreadable|invalid|malformed)|youtube_upload\\.json.*${episodeId}.*(?:unreadable|invalid|malformed)`, 'i'),
    )
  } finally {
    await temp.cleanup()
  }
})

test('an EACCES upload sidecar cannot become an empty thumbnail backfill', async () => {
  const temp = await useTempDataDir()
  let episodeDir = ''
  try {
    const { generateThumbnailRefresh } = await import('../generators/youtube-thumbnail-refresh.js')
    const { project, episodeId, paths, credential } = await configureYouTubeEpisode('Unreadable thumbnail sidecar execution')
    episodeDir = paths.episode_dir
    await writeUploadSidecar(episodeDir, credential.accountId, false)
    await fs.chmod(episodeDir, 0o000)
    const run = job(project.slug, episodeId, 'youtube_thumbnail_refresh', { mode: 'missing' })

    await assert.rejects(
      () => generateThumbnailRefresh(run),
      new RegExp(`${episodeId}.*youtube_upload\\.json.*(?:unreadable|resolve|access)|youtube_upload\\.json.*${episodeId}.*(?:unreadable|resolve|access)`, 'i'),
    )
  } finally {
    if (episodeDir) await fs.chmod(episodeDir, 0o700).catch(() => {})
    await temp.cleanup()
  }
})

test('thumbnail refresh preview rejects an EACCES sidecar instead of publishing partial counts', async () => {
  const temp = await useTempDataDir()
  let episodeDir = ''
  try {
    const { previewThumbnailRefresh } = await import('../generators/youtube-thumbnail-refresh.js')
    const { project, episodeId, paths, credential } = await configureYouTubeEpisode('Unreadable thumbnail sidecar preview')
    episodeDir = paths.episode_dir
    await writeUploadSidecar(episodeDir, credential.accountId, false)
    await fs.chmod(episodeDir, 0o000)

    await assert.rejects(
      () => previewThumbnailRefresh(project.slug, { mode: 'missing', platform: 'youtube' }),
      new RegExp(`${episodeId}.*youtube_upload\\.json.*(?:unreadable|resolve|access)|youtube_upload\\.json.*${episodeId}.*(?:unreadable|resolve|access)`, 'i'),
    )
  } finally {
    if (episodeDir) await fs.chmod(episodeDir, 0o700).catch(() => {})
    await temp.cleanup()
  }
})

test('a genuinely absent upload sidecar remains a measured zero for preview and execution', async () => {
  const temp = await useTempDataDir()
  try {
    const { generateThumbnailRefresh, previewThumbnailRefresh } = await import('../generators/youtube-thumbnail-refresh.js')
    const { project, episodeId } = await configureYouTubeEpisode('No upload sidecar')
    const preview = await previewThumbnailRefresh(project.slug, { mode: 'missing', platform: 'youtube' })
    const run = job(project.slug, episodeId, 'youtube_thumbnail_refresh', { mode: 'missing' })

    assert.equal(preview.total_uploaded, 0)
    assert.equal(preview.will_fix, 0)
    assert.equal(preview.no_image, 0)
    await generateThumbnailRefresh(run)
    assert.equal(run.result?.complete, true)
    assert.equal(run.result?.completion?.expected, 0)
  } finally {
    await temp.cleanup()
  }
})

test('successful upload enumeration with no eligible rows remains a valid zero-item backfill', async () => {
  const temp = await useTempDataDir()
  try {
    const { generateThumbnailRefresh } = await import('../generators/youtube-thumbnail-refresh.js')
    const { project, episodeId, paths, credential } = await configureYouTubeEpisode('No thumbnail backfill targets')
    await writeUploadSidecar(paths.episode_dir, credential.accountId, true)
    const run = job(project.slug, episodeId, 'youtube_thumbnail_refresh', { mode: 'missing' })

    await generateThumbnailRefresh(run)

    assert.equal(run.result?.complete, true)
    assert.equal(run.result?.completion?.expected, 0)
  } finally {
    await temp.cleanup()
  }
})

test('an explicit playlist _none_ selection remains a valid zero-item opt-out', async () => {
  const temp = await useTempDataDir()
  try {
    const { generateYoutubePlaylistUpdate } = await import('../generators/youtube-playlist-update.js')
    const { project, episodeId, paths, credential } = await configureYouTubeEpisode('Playlist opt-out')
    await writeUploadSidecar(paths.episode_dir, credential.accountId, false)
    const run = job(project.slug, episodeId, 'youtube_playlist_update', {
      episode_id: episodeId,
      playlist_id: '_none_',
    })
    let providerCalls = 0

    await generateYoutubePlaylistUpdate(run, {
      ensureMembership: (async () => {
        providerCalls++
        return { inserted: true, verified: true }
      }) as any,
    })

    assert.equal(run.result?.complete, true)
    assert.equal(run.result?.completion?.expected, 0)
    assert.equal(providerCalls, 0)
  } finally {
    await temp.cleanup()
  }
})
