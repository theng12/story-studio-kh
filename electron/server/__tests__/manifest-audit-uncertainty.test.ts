import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

const slug = 'manifest-audit-uncertainty'

function taskManifest(code: string, filename: string): string {
  return JSON.stringify({
    schema_version: 1,
    tasks: {
      [filename]: {
        provider: 'test',
        task_id: `task-${code}`,
        submitted_at: '2026-09-21T00:00:00.000Z',
      },
    },
  })
}

async function seedVideo(
  episodeDir: string,
  code: string,
): Promise<{ clipPath: string; manifestPath: string }> {
  const videoDir = path.join(episodeDir, `${code} - 10 Video Assembly Output`)
  const filename = `${code}_Scene01.mp4`
  const clipPath = path.join(videoDir, filename)
  const manifestPath = path.join(videoDir, '.task-manifest.json')
  await fs.mkdir(videoDir, { recursive: true })
  await Promise.all([
    fs.writeFile(clipPath, 'complete clip'),
    fs.writeFile(manifestPath, taskManifest(code, filename)),
  ])
  return { clipPath, manifestPath }
}

async function seedProject(tempDir: string): Promise<{
  blockedParent: string
  blockedEpisode: string
  healthyEpisode: string
  blockedClip: string
  blockedManifest: string
}> {
  const projectDir = path.join(tempDir, 'projects', slug)
  const episodesDir = path.join(projectDir, 'episodes')
  const blockedParent = path.join(episodesDir, 'Blocked Season')
  const blockedEpisode = path.join(blockedParent, 'EP0001 - Blocked')
  const healthyEpisode = path.join(episodesDir, 'EP0002 - Healthy')
  await fs.mkdir(projectDir, { recursive: true })
  const [, , blockedVideo] = await Promise.all([
    fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug,
      name: 'Manifest audit uncertainty',
      episode_prefix: 'EP',
    })),
    fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
      ideas: [
        { id: 'idea-1', title: 'Blocked', status: 'accepted', episode_code: 'EP0001' },
        { id: 'idea-2', title: 'Healthy', status: 'accepted', episode_code: 'EP0002' },
      ],
      next_episode_number: 3,
      recycled_numbers: [],
    })),
    seedVideo(blockedEpisode, 'EP0001'),
    seedVideo(healthyEpisode, 'EP0002'),
  ])
  return {
    blockedParent,
    blockedEpisode,
    healthyEpisode,
    blockedClip: blockedVideo.clipPath,
    blockedManifest: blockedVideo.manifestPath,
  }
}

test('an unreadable episode branch is explicit, preserves measured stages, and recovers on retry', async (t) => {
  const temp = await useTempDataDir()
  try {
    const { blockedParent } = await seedProject(temp.dir)
    const { auditAssets } = await import('../services/manifest-audit.js')
    const baseline = await auditAssets(slug)
    const baselineVideo = baseline.episodes[0].stages.find(stage => stage.stage === 'video')!
    assert.deepEqual(
      { started: baselineVideo.started, expected: baselineVideo.expected, present: baselineVideo.present },
      { started: true, expected: 1, present: 1 },
      'the fixture must begin with a completely measured video stage',
    )

    const read = fs.readdir.bind(fs)
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      const [target, options] = args as [unknown, { withFileTypes?: boolean }?]
      if (path.resolve(String(target)) === blockedParent && options?.withFileTypes === true) {
        throw Object.assign(new Error('simulated permission denial'), { code: 'EACCES' })
      }
      return read(...args)
    })

    const denied = await auditAssets(slug)
    const blocked = denied.episodes.find(episode => episode.episode_code === 'EP0001')!
    const healthy = denied.episodes.find(episode => episode.episode_code === 'EP0002')!
    const blockedVideo = blocked.stages.find(stage => stage.stage === 'video')!
    const blockedMerged = blocked.stages.find(stage => stage.stage === 'merged_audio')!
    const healthyVideo = healthy.stages.find(stage => stage.stage === 'video')!
    const untouchedAudio = healthy.stages.find(stage => stage.stage === 'audio')!

    assert.equal(blockedVideo.outcome, 'unmeasurable')
    assert.equal(blockedVideo.started, false, 'legacy started remains compatible')
    assert.deepEqual(
      { expected: blockedVideo.expected, present: blockedVideo.present, missing: blockedVideo.missing },
      { expected: 0, present: 0, missing: [] },
      'an unmeasurable stage must not invent manifest counts',
    )
    assert.match(blockedVideo.error ?? '', /could not measure.*retry/i)
    assert.equal(blockedMerged.outcome, 'unmeasurable')
    assert.equal(healthyVideo.outcome, 'measured')
    assert.deepEqual(
      { started: healthyVideo.started, expected: healthyVideo.expected, present: healthyVideo.present },
      { started: true, expected: 1, present: 1 },
      'one failed stage must not erase a successful measurement',
    )
    assert.equal(
      untouchedAudio.outcome,
      'unmeasurable',
      'global narration discovery cannot prove absence through an unreadable sibling branch',
    )
    assert.equal(untouchedAudio.started, false)
    assert.match(untouchedAudio.error ?? '', /could not measure.*retry/i)
    assert.equal(denied.total_missing, 0, 'unknown stages are not fabricated as missing assets')

    t.mock.restoreAll()
    const retried = await auditAssets(slug)
    const recoveredBlocked = retried.episodes.find(episode => episode.episode_code === 'EP0001')!
    const recoveredHealthy = retried.episodes.find(episode => episode.episode_code === 'EP0002')!
    const recoveredVideo = recoveredBlocked
      .stages.find(stage => stage.stage === 'video')!
    const confirmedUntouchedAudio = recoveredHealthy
      .stages.find(stage => stage.stage === 'audio')!
    assert.deepEqual(
      {
        outcome: recoveredVideo.outcome,
        started: recoveredVideo.started,
        expected: recoveredVideo.expected,
        present: recoveredVideo.present,
        missing: recoveredVideo.missing,
      },
      { outcome: 'measured', started: true, expected: 1, present: 1, missing: [] },
      'retry must measure the existing clip after access is restored',
    )
    assert.equal(confirmedUntouchedAudio.outcome, 'not_started')
    assert.equal(confirmedUntouchedAudio.started, false)
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})

test('a corrupt task manifest is unmeasurable until repaired', async (t) => {
  const temp = await useTempDataDir()
  try {
    const { blockedManifest } = await seedProject(temp.dir)
    const { auditAssets } = await import('../services/manifest-audit.js')
    await fs.writeFile(blockedManifest, '{not json')

    const corrupted = await auditAssets(slug)
    const blockedVideo = corrupted.episodes
      .find(episode => episode.episode_code === 'EP0001')!
      .stages.find(stage => stage.stage === 'video')!
    const healthyVideo = corrupted.episodes
      .find(episode => episode.episode_code === 'EP0002')!
      .stages.find(stage => stage.stage === 'video')!
    assert.equal(blockedVideo.outcome, 'unmeasurable')
    assert.equal(blockedVideo.started, false)
    assert.match(blockedVideo.error ?? '', /could not measure.*retry/i)
    assert.equal(healthyVideo.outcome, 'measured')

    await fs.writeFile(blockedManifest, taskManifest('EP0001', 'EP0001_Scene01.mp4'))
    const repaired = await auditAssets(slug)
    const recoveredVideo = repaired.episodes
      .find(episode => episode.episode_code === 'EP0001')!
      .stages.find(stage => stage.stage === 'video')!
    assert.equal(recoveredVideo.outcome, 'measured')
    assert.equal(recoveredVideo.present, 1)
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})

async function seedAudio(episodeDir: string, code: string): Promise<{ audioPath: string }> {
  const scriptDir = path.join(episodeDir, `${code} - 01 Script`)
  const audioDir = path.join(episodeDir, `${code} - 07 Audio Assets`)
  const filename = `${code}_Chapter_01.mp3`
  const audioPath = path.join(audioDir, filename)
  await Promise.all([
    fs.mkdir(scriptDir, { recursive: true }),
    fs.mkdir(audioDir, { recursive: true }),
  ])
  await Promise.all([
    fs.writeFile(path.join(scriptDir, `${code}_Script_Narration.md`), [
      '# Narration', '',
      '## Chapter 1: One', '',
      'A complete narration section for the manifest audit fixture.', '',
    ].join('\n')),
    fs.writeFile(audioPath, 'complete audio'),
    fs.writeFile(path.join(audioDir, '.task-manifest.json'), taskManifest(code, filename)),
  ])
  return { audioPath }
}

async function seedImages(episodeDir: string, code: string): Promise<void> {
  const scenePromptsDir = path.join(episodeDir, `${code} - 03 Scene Prompts`)
  const thumbPromptsDir = path.join(episodeDir, `${code} - 04 Thumbnail Prompts`)
  const imagesDir = path.join(episodeDir, `${code} - 05 Scene Images`)
  const thumbnailsDir = path.join(episodeDir, `${code} - 06 Thumbnail Images`)
  const sceneName = `${code}_Scene01_v1.png`
  const thumbName = `${code}_Thumb01_v1.png`
  await Promise.all([
    fs.mkdir(scenePromptsDir, { recursive: true }),
    fs.mkdir(thumbPromptsDir, { recursive: true }),
    fs.mkdir(imagesDir, { recursive: true }),
    fs.mkdir(thumbnailsDir, { recursive: true }),
  ])
  await Promise.all([
    fs.writeFile(path.join(scenePromptsDir, `${code}_Scene_Prompts.md`), [
      '# Scene Prompts', '', '## Scene 1: One', '', 'A complete scene prompt.', '',
    ].join('\n')),
    fs.writeFile(path.join(thumbPromptsDir, `${code}_Thumbnail_Prompts.md`), [
      '# Thumbnail Prompts', '', '## Thumbnail 1: One', '', 'A complete thumbnail prompt.', '',
    ].join('\n')),
    fs.writeFile(path.join(imagesDir, sceneName), 'complete scene image'),
    fs.writeFile(path.join(thumbnailsDir, thumbName), 'complete thumbnail image'),
    fs.writeFile(path.join(imagesDir, '.task-manifest.json'), taskManifest(code, sceneName)),
    fs.writeFile(path.join(thumbnailsDir, '.task-manifest.json'), taskManifest(code, thumbName)),
  ])
}

test('a denied expected audio stat is unmeasurable instead of an ordinary missing chunk', async (t) => {
  const temp = await useTempDataDir()
  try {
    const { blockedEpisode } = await seedProject(temp.dir)
    const { audioPath } = await seedAudio(blockedEpisode, 'EP0001')
    const { auditAssets } = await import('../services/manifest-audit.js')
    const stat = fs.stat.bind(fs)
    t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
      if (path.resolve(String(args[0])) === audioPath) {
        throw Object.assign(new Error('simulated permission denial'), { code: 'EACCES' })
      }
      return stat(...args)
    })

    const denied = await auditAssets(slug)
    const audio = denied.episodes
      .find(episode => episode.episode_code === 'EP0001')!
      .stages.find(stage => stage.stage === 'audio')!
    const healthyVideo = denied.episodes
      .find(episode => episode.episode_code === 'EP0002')!
      .stages.find(stage => stage.stage === 'video')!
    assert.equal(audio.outcome, 'unmeasurable')
    assert.equal(audio.started, false)
    assert.deepEqual(audio.missing, [])
    assert.match(audio.error ?? '', /could not measure.*retry/i)
    assert.equal(healthyVideo.outcome, 'measured')

    t.mock.restoreAll()
    const retried = await auditAssets(slug)
    const recoveredAudio = retried.episodes
      .find(episode => episode.episode_code === 'EP0001')!
      .stages.find(stage => stage.stage === 'audio')!
    assert.equal(recoveredAudio.outcome, 'measured')
    assert.equal(recoveredAudio.present, 1)
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})

test('denied audio discovery is unmeasurable and recovers on retry', async (t) => {
  const temp = await useTempDataDir()
  try {
    const { blockedEpisode, blockedParent } = await seedProject(temp.dir)
    await seedAudio(blockedEpisode, 'EP0001')
    const { auditAssets } = await import('../services/manifest-audit.js')
    const read = fs.readdir.bind(fs)
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      const [target, options] = args as [unknown, { withFileTypes?: boolean }?]
      if (path.resolve(String(target)) === blockedParent && options?.withFileTypes === true) {
        throw Object.assign(new Error('simulated permission denial'), { code: 'EACCES' })
      }
      return read(...args)
    })

    const denied = await auditAssets(slug)
    const blocked = denied.episodes.find(episode => episode.episode_code === 'EP0001')!
    const healthyVideo = denied.episodes
      .find(episode => episode.episode_code === 'EP0002')!
      .stages.find(stage => stage.stage === 'video')!
    const audio = blocked.stages.find(stage => stage.stage === 'audio')!
    assert.equal(audio.outcome, 'unmeasurable', 'audio discovery must preserve EACCES')
    assert.equal(audio.started, false)
    assert.match(audio.error ?? '', /could not measure.*retry/i)
    assert.equal(healthyVideo.outcome, 'measured')

    t.mock.restoreAll()
    const retried = await auditAssets(slug)
    const recovered = retried.episodes.find(episode => episode.episode_code === 'EP0001')!
    const recoveredAudio = recovered.stages.find(stage => stage.stage === 'audio')!
    assert.equal(recoveredAudio.outcome, 'measured')
    assert.equal(recoveredAudio.present, 1)
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})

test('denied image discovery is unmeasurable and recovers on retry', async (t) => {
  const temp = await useTempDataDir()
  try {
    const { blockedEpisode, blockedParent } = await seedProject(temp.dir)
    await seedImages(blockedEpisode, 'EP0001')
    const { auditAssets } = await import('../services/manifest-audit.js')
    const read = fs.readdir.bind(fs)
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      const [target, options] = args as [unknown, { withFileTypes?: boolean }?]
      if (path.resolve(String(target)) === blockedParent && options?.withFileTypes === true) {
        throw Object.assign(new Error('simulated permission denial'), { code: 'EACCES' })
      }
      return read(...args)
    })

    const denied = await auditAssets(slug)
    const blocked = denied.episodes.find(episode => episode.episode_code === 'EP0001')!
    const healthyVideo = denied.episodes
      .find(episode => episode.episode_code === 'EP0002')!
      .stages.find(stage => stage.stage === 'video')!
    for (const stage of ['scenes', 'thumbnails'] as const) {
      const result = blocked.stages.find(candidate => candidate.stage === stage)!
      assert.equal(result.outcome, 'unmeasurable', `${stage} discovery must preserve EACCES`)
      assert.equal(result.started, false)
      assert.match(result.error ?? '', /could not measure.*retry/i)
    }
    assert.equal(healthyVideo.outcome, 'measured')

    t.mock.restoreAll()
    const retried = await auditAssets(slug)
    const recovered = retried.episodes.find(episode => episode.episode_code === 'EP0001')!
    for (const stage of ['scenes', 'thumbnails'] as const) {
      const result = recovered.stages.find(candidate => candidate.stage === stage)!
      assert.equal(result.outcome, 'measured', `${stage} must recover after access is restored`)
      assert.equal(result.present, 1)
    }
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})

test('denied manifest reads and artifact stats are unmeasurable, not absent or missing', async (t) => {
  const temp = await useTempDataDir()
  try {
    const { blockedClip, blockedManifest } = await seedProject(temp.dir)
    const { auditAssets } = await import('../services/manifest-audit.js')
    const deny = () => Object.assign(new Error('simulated permission denial'), { code: 'EACCES' })

    const readFile = fs.readFile.bind(fs)
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (path.resolve(String(args[0])) === blockedManifest) throw deny()
      return readFile(...args)
    })
    const unreadableManifest = await auditAssets(slug)
    const manifestStage = unreadableManifest.episodes
      .find(episode => episode.episode_code === 'EP0001')!
      .stages.find(stage => stage.stage === 'video')!
    assert.equal(manifestStage.outcome, 'unmeasurable')
    assert.equal(manifestStage.started, false)
    assert.match(manifestStage.error ?? '', /could not measure.*retry/i)

    t.mock.restoreAll()
    const stat = fs.stat.bind(fs)
    t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
      if (path.resolve(String(args[0])) === blockedClip) throw deny()
      return stat(...args)
    })
    const unreadableClip = await auditAssets(slug)
    const clipStage = unreadableClip.episodes
      .find(episode => episode.episode_code === 'EP0001')!
      .stages.find(stage => stage.stage === 'video')!
    const healthyVideo = unreadableClip.episodes
      .find(episode => episode.episode_code === 'EP0002')!
      .stages.find(stage => stage.stage === 'video')!
    const untouchedAudio = unreadableClip.episodes
      .find(episode => episode.episode_code === 'EP0002')!
      .stages.find(stage => stage.stage === 'audio')!
    assert.equal(clipStage.outcome, 'unmeasurable')
    assert.equal(clipStage.started, false)
    assert.match(clipStage.error ?? '', /could not measure.*retry/i)
    assert.equal(healthyVideo.outcome, 'measured')
    assert.equal(untouchedAudio.outcome, 'not_started')

    t.mock.restoreAll()
    const retried = await auditAssets(slug)
    const recoveredVideo = retried.episodes
      .find(episode => episode.episode_code === 'EP0001')!
      .stages.find(stage => stage.stage === 'video')!
    assert.equal(recoveredVideo.outcome, 'measured')
    assert.equal(recoveredVideo.present, 1)
  } finally {
    t.mock.restoreAll()
    await temp.cleanup()
  }
})
