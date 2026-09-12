import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor, waitForValue } from './_timing.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import type { MediaCleanupCategory } from '../services/episode-media-cleanup.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
} from '../lib/youtube-client.js'

let cleanup: typeof import('../services/episode-media-cleanup.js')
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let pathsService: typeof import('../services/utils.js')
let connections: typeof import('../services/youtube-connection-store.js')
let operations: typeof import('../services/youtube-operation-store.js')
let sourceVideo: typeof import('../services/youtube-source-video.js')
let jq: typeof import('../services/job-queue.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'cleanup-test'
const CHANNEL = 'cleanup-channel'

before(async () => {
  tmp = await useTempDataDir()
  cleanup = await import('../services/episode-media-cleanup.js')
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  pathsService = await import('../services/utils.js')
  connections = await import('../services/youtube-connection-store.js')
  operations = await import('../services/youtube-operation-store.js')
  sourceVideo = await import('../services/youtube-source-video.js')
  jq = await import('../services/job-queue.js')
})

beforeEach(async () => {
  await tmp.cleanup()
  tmp = await useTempDataDir()
  cleanup._resetMediaCleanupStateForTests()
  const projectDir = path.join(pm.projectsRoot(), SLUG)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Cleanup Test',
    episode_prefix: 'EP',
    episode_digits: 4,
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: DEFAULT_SUBFOLDER_NAMES,
    created_at: new Date().toISOString(),
  }))
  await fs.writeFile(path.join(projectDir, 'config.json'), '{}')
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [], next_episode_number: 1, recycled_numbers: [],
  }))
})

after(async () => { await tmp.cleanup() })
afterEach(() => { __resetYouTubeTransportForTests() })

async function seedEpisode(code: string, title = `Episode ${code}`) {
  const [idea] = await im.addIdeas(SLUG, [{
    title, logline: '', themes: [], suggested_chapters: 1,
    suggested_length: 'short', mood: 'calm',
  }], 'test')
  await im.acceptIdea(SLUG, idea!.id, false, { override_code: code })
  const paths = await pathsService.resolveEpisodePathsByCode(SLUG, code)
  await Promise.all([
    fs.mkdir(paths.bg_dir, { recursive: true }),
    fs.mkdir(paths.thumb_dir, { recursive: true }),
    fs.mkdir(paths.audio_dir, { recursive: true }),
    fs.mkdir(paths.merged_audio_dir, { recursive: true }),
    fs.mkdir(paths.video_assets_dir, { recursive: true }),
    fs.mkdir(paths.video_dir, { recursive: true }),
    fs.mkdir(paths.script_dir, { recursive: true }),
    fs.mkdir(paths.subtitles_dir, { recursive: true }),
  ])
  const final = path.join(paths.video_dir, `${code}_final_video.mp4`)
  await fs.writeFile(final, `final-${code}`)
  await makeOlder(final)
  return { code, title, paths, final }
}

async function makeOlder(file: string): Promise<void> {
  const beforeUpload = new Date(Date.now() - 60_000)
  await fs.utimes(file, beforeUpload, beforeUpload)
}

async function waitForTerminalJob(jobId: string): Promise<void> {
  await waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || ''), { timeoutMs: 2_000 })
}

async function markUploaded(episode: Awaited<ReturnType<typeof seedEpisode>>): Promise<void> {
  await connections.configureYouTubeApplication({ client_id: 'cleanup-client', client_secret: 'cleanup-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Cleanup Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: SLUG, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  const payload = {
    snippet_json: JSON.stringify({ title: episode.title, description: '', tags: [], categoryId: '24' }),
    status_json: JSON.stringify({ privacyStatus: 'public' }),
    source_sha256: 'a'.repeat(64),
  }
  const opened = await operations.createYouTubeOperation({
    project_slug: SLUG,
    episode_code: episode.code,
    channel_id: CHANNEL,
    source_revision: await sourceVideo.resolveYouTubeSourceRevision(episode.final),
    metadata_revision: payload.source_sha256,
    final_payload: payload,
    origin: 'manual',
    final_action: 'manual_upload',
  })
  const acceptedAt = new Date().toISOString()
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: SLUG,
    operation_id: opened.operation_id,
    expected_revision: opened.revision,
    channel_id: CHANNEL,
    video_id: `video-${episode.code}`,
    accepted_at: acceptedAt,
    final_payload: payload,
  })
  await operations.updateYouTubeOperation({
    project_slug: SLUG,
    operation_id: accepted.operation_id,
    expected_revision: accepted.revision,
    mutate(record) { record.lifecycle = 'ready' },
  })
}

async function waitForOperation(operationId: string) {
  return waitForValue(() => {
    const current = cleanup.getMediaCleanupOperation(SLUG, operationId)
    return current && ['completed', 'failed', 'stopped'].includes(current.status) ? current : null
  }, { timeoutMs: 5_000, label: `media cleanup operation ${operationId}` })
}

async function preview(
  episodeCodes: string[],
  categories: MediaCleanupCategory[],
) {
  const started = await cleanup.startMediaCleanupPreview(SLUG, {
    episode_codes: episodeCodes,
    categories,
  })
  const operation = await waitForOperation(started.operation_id)
  assert.equal(operation.status, 'completed', operation.error)
  assert.ok(operation.preview)
  return operation.preview
}

async function run(
  previewId: string,
  mode: 'archive' | 'remove',
  destination?: string,
) {
  const started = await cleanup.startMediaCleanupRun(SLUG, {
    preview_id: previewId, mode, ...(destination ? { destination } : {}),
  })
  return waitForOperation(started.operation_id)
}

describe('episode media cleanup preview', () => {
  test('lists only episodes with a ready canonical upload on the current channel', async () => {
    const uploaded = await seedEpisode('EP0001')
    await seedEpisode('EP0002')
    await markUploaded(uploaded)

    const result = await cleanup.listMediaCleanupEpisodes(SLUG)

    assert.deepEqual(result.episodes.map(row => ({ code: row.episode_code, video: row.video_id })), [
      { code: 'EP0001', video: 'video-EP0001' },
    ])
  })

  test('reviews only selected media files and preserves scripts subtitles settings and ImagePool', async () => {
    const episode = await seedEpisode('EP0001')
    const scene = path.join(episode.paths.bg_dir, 'scene-01.png')
    const merged = path.join(episode.paths.merged_audio_dir, 'merged.mp3')
    const chapter = path.join(episode.paths.audio_dir, 'chapter.mp3')
    const script = path.join(episode.paths.script_dir, 'script.md')
    const subtitle = path.join(episode.paths.subtitles_dir, 'captions.srt')
    const imagePool = path.join(pm.getProjectDir(SLUG)!, 'ImagePool', 'shared.png')
    await fs.mkdir(path.dirname(imagePool), { recursive: true })
    await Promise.all([
      fs.writeFile(scene, 'scene-bytes'),
      fs.writeFile(merged, 'merged-bytes'),
      fs.writeFile(chapter, 'chapter-bytes'),
      fs.writeFile(script, 'script'),
      fs.writeFile(subtitle, 'subtitle'),
      fs.writeFile(imagePool, 'shared'),
    ])
    await Promise.all([scene, merged, chapter].map(makeOlder))
    await markUploaded(episode)

    const bill = await preview(['EP0001'], ['images', 'merged_audio'])
    assert.deepEqual(bill.files.map(file => file.path).sort(), [merged, scene].sort())
    assert.equal(bill.total_bytes, 23)

    const operation = await run(bill.preview_id, 'remove')
    assert.equal(operation.status, 'completed', operation.error)
    assert.equal(operation.result?.removed_count, 2)
    assert.equal(existsSync(scene), false)
    assert.equal(existsSync(merged), false)
    assert.equal(existsSync(chapter), true)
    assert.equal(existsSync(script), true)
    assert.equal(existsSync(subtitle), true)
    assert.equal(existsSync(imagePool), true)
    const status = await cleanup.readLocalMediaCleanupStatus(SLUG, 'EP0001')
    assert.equal(status.state, 'partially_removed')
    assert.equal(status.has_retired_media, true)
    assert.equal(status.categories.reduce((sum, row) => sum + row.removed_files, 0), 2)
  })

  test('excludes media created after upload and refuses an episode with no canonical upload', async () => {
    const uploaded = await seedEpisode('EP0001')
    const notUploaded = await seedEpisode('EP0002')
    await markUploaded(uploaded)
    const fresh = path.join(uploaded.paths.bg_dir, 'regenerated.png')
    await fs.writeFile(fresh, 'new')
    const old = path.join(notUploaded.paths.bg_dir, 'old.png')
    await fs.writeFile(old, 'old')
    await makeOlder(old)

    const bill = await preview(['EP0001', 'EP0002'], ['images'])

    assert.equal(bill.files.length, 0)
    assert.match(bill.episodes.find(row => row.episode_code === 'EP0001')!.blocked_reasons.join(' '), /newer than/i)
    assert.match(bill.episodes.find(row => row.episode_code === 'EP0002')!.blocked_reasons.join(' '), /ready canonical upload/i)
  })

  test('rejects an active relevant scope and excludes symlinks hardlinks and shared roots', async () => {
    const episode = await seedEpisode('EP0001')
    const regular = path.join(episode.paths.bg_dir, 'regular.png')
    const hardlink = path.join(episode.paths.bg_dir, 'hardlink.png')
    const outside = path.join(tmp.dir, 'outside.png')
    const symlink = path.join(episode.paths.bg_dir, 'symlink.png')
    await fs.writeFile(regular, 'linked')
    await fs.link(regular, hardlink)
    await fs.writeFile(outside, 'outside')
    await fs.symlink(outside, symlink)
    await Promise.all([regular, hardlink, outside].map(makeOlder))
    await markUploaded(episode)

    const bill = await preview(['EP0001'], ['images'])
    assert.equal(bill.files.length, 0)
    assert.match(bill.episodes[0]!.blocked_reasons.join(' '), /hard link|symbolic link/i)

    const restore = cleanup._setMediaCleanupHooksForTests({
      getJobs: async () => [{
        project_slug: SLUG, episode_id: 'EP0001', type: 'script-only', status: 'running',
      } as any],
    })
    try {
      const started = await cleanup.startMediaCleanupPreview(SLUG, {
        episode_codes: ['EP0001'], categories: ['images'],
      })
      const blocked = await waitForOperation(started.operation_id)
      assert.equal(blocked.status, 'failed')
      assert.match(blocked.error || '', /active.*script-only/i)
    } finally {
      restore()
    }
  })

  test('final video requires the exact current-channel receipt and fresh YouTube readiness', async () => {
    const episode = await seedEpisode('EP0001')
    await markUploaded(episode)
    let remoteChecks = 0
    __setYouTubeTransportForTests((async () => {
      remoteChecks += 1
      return new Response(JSON.stringify({
        items: [{
          id: 'video-EP0001',
          status: { uploadStatus: 'processed', privacyStatus: 'private' },
          snippet: { channelId: CHANNEL, title: episode.title, description: '', tags: [] },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    const exact = await preview(['EP0001'], ['final_video'])
    assert.deepEqual(exact.files.map(file => file.path), [episode.final])
    assert.equal(remoteChecks, 1)

    await fs.writeFile(episode.final, `other-${episode.code}`)
    await makeOlder(episode.final)
    const replaced = await preview(['EP0001'], ['final_video'])
    assert.equal(replaced.files.length, 0)
    assert.match(replaced.episodes[0]!.blocked_reasons.join(' '), /matching content SHA-256|exact render/i)
    assert.equal(remoteChecks, 1, 'hash mismatch is refused before a remote readiness lookup')
  })

  test('refuses a configured media root reached through a symbolic-link ancestor', async () => {
    const projectFile = path.join(pm.getProjectDir(SLUG)!, 'project.json')
    const project = JSON.parse(await fs.readFile(projectFile, 'utf8'))
    const physicalRoot = path.join(tmp.dir, 'physical-media')
    const linkedRoot = path.join(tmp.dir, 'linked-media')
    await fs.mkdir(physicalRoot, { recursive: true })
    await fs.symlink(physicalRoot, linkedRoot)
    project.media_root = linkedRoot
    await fs.writeFile(projectFile, JSON.stringify(project))
    const episode = await seedEpisode('EP0001')
    const image = path.join(episode.paths.bg_dir, 'scene.png')
    await fs.writeFile(image, 'scene')
    await makeOlder(image)
    await markUploaded(episode)

    const bill = await preview(['EP0001'], ['images'])

    assert.equal(bill.files.length, 0)
    assert.match(bill.episodes[0]!.blocked_reasons.join(' '), /symbolic-link ancestor/i)
  })
})

describe('episode media cleanup execution', () => {
  test('does not follow a media directory replaced with a link after preview', async () => {
    const episode = await seedEpisode('EP0001')
    const image = path.join(episode.paths.bg_dir, 'scene.png')
    await fs.writeFile(image, 'scene')
    await makeOlder(image)
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['images'])
    const moved = `${episode.paths.bg_dir}-moved`
    await fs.rename(episode.paths.bg_dir, moved)
    await fs.symlink(moved, episode.paths.bg_dir)
    const operation = await run(bill.preview_id, 'remove')
    assert.equal(operation.result?.removed_count, 0)
    assert.equal(operation.result?.items[0]?.outcome, 'skipped')
    assert.match(operation.result?.items[0]?.reason || '', /location changed/)
    assert.equal(await fs.readFile(path.join(moved, 'scene.png'), 'utf8'), 'scene')
  })

  test('keeps a cleanup sidecar discoverable when a title change leaves the old folder in place', async () => {
    const episode = await seedEpisode('EP0001', 'Original title')
    const image = path.join(episode.paths.bg_dir, 'scene.png')
    await fs.writeFile(image, 'scene')
    await makeOlder(image)
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['images'])
    const operation = await run(bill.preview_id, 'remove')
    assert.equal(operation.result?.removed_count, 1)

    const idea = (await im.getIdeas(SLUG, 'accepted')).find(candidate => candidate.episode_code === episode.code)!
    await im.updateIdea(SLUG, idea.id, { title: 'Renamed title' })
    const renamedPaths = await pathsService.resolveEpisodePathsByCode(SLUG, episode.code)
    assert.notEqual(renamedPaths.episode_dir, episode.paths.episode_dir)

    const status = await cleanup.readLocalMediaCleanupStatus(SLUG, episode.code)
    assert.equal(status.has_retired_media, true)
    assert.equal(status.categories[0]?.removed_files, 1)

    await fs.rename(episode.paths.episode_dir, renamedPaths.episode_dir)
    const restored = path.join(renamedPaths.bg_dir, 'scene.png')
    await fs.writeFile(restored, 'regenerated scene')
    const restoredStatus = await cleanup.readLocalMediaCleanupStatus(SLUG, episode.code)
    assert.equal(restoredStatus.has_retired_media, false, 'a regenerated current-path file clears the old-folder retirement marker')

    await fs.unlink(restored)
    const absentStatus = await cleanup.readLocalMediaCleanupStatus(SLUG, episode.code)
    assert.equal(absentStatus.has_retired_media, true, 'without the restored current-path file, the old cleanup record remains protective')

    await fs.writeFile(restored, 'regenerated scene')
    await makeOlder(restored)
    const repeated = await preview(['EP0001'], ['images'])
    assert.equal(repeated.files.length, 1)
    assert.equal((await run(repeated.preview_id, 'remove')).result?.removed_count, 1)
    const cleanedAgain = await cleanup.readLocalMediaCleanupStatus(SLUG, episode.code)
    assert.equal(cleanedAgain.categories[0]?.removed_files, 1, 'renamed history counts the current logical file only once')
    assert.equal(cleanedAgain.categories[0]?.bytes_reclaimed, Buffer.byteLength('regenerated scene'))
  })

  test('waits for episode job admission before removing a reviewed non-final file', async () => {
    const episode = await seedEpisode('EP0001')
    const image = path.join(episode.paths.bg_dir, 'scene.png')
    await fs.writeFile(image, 'scene')
    await makeOlder(image)
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['images'])
    let operationId = ''

    await jq.withEpisodeMediaAdmissionLock(SLUG, episode.code, async () => {
      const started = await cleanup.startMediaCleanupRun(SLUG, { preview_id: bill.preview_id, mode: 'remove' })
      operationId = started.operation_id
      await waitFor(() => cleanup.getMediaCleanupOperation(SLUG, operationId)?.current === image, { timeoutMs: 2_000 })
      assert.equal(existsSync(image), true, 'cleanup must wait for an in-flight job admission')
    })

    const operation = await waitForOperation(operationId)
    assert.equal(operation.status, 'completed', operation.error)
    assert.equal(operation.result?.removed_count, 1)
    assert.equal(existsSync(image), false)
  })

  test('rejects a synchronous terminal retry while cleanup owns episode admission', async () => {
    const episode = await seedEpisode('EP0001')
    const image = path.join(episode.paths.bg_dir, 'scene.png')
    await fs.writeFile(image, 'scene')
    await makeOlder(image)
    await markUploaded(episode)
    jq.registerExecutor('metadata', async () => { throw new Error('terminal fixture') })
    const terminal = jq.enqueuePreparedForTest({
      project_slug: SLUG, type: 'metadata', episode_id: episode.code, title: 'terminal fixture', params: {},
    })
    await waitForTerminalJob(terminal.job_id)
    assert.equal(jq.getJob(terminal.job_id)?.status, 'error')
    const bill = await preview(['EP0001'], ['images'])
    let checkedAdmission = false
    const restore = cleanup._setMediaCleanupHooksForTests({
      beforeDestructiveMutation: async () => {
        assert.throws(
          () => jq.retryTerminalJob(SLUG, terminal.job_id),
          /local media cleanup is in progress.*try again shortly/i,
        )
        assert.equal(existsSync(image), true, 'the retry is rejected before cleanup removes the reviewed file')
        checkedAdmission = true
      },
    })
    try {
      const operation = await run(bill.preview_id, 'remove')
      assert.equal(operation.status, 'completed', operation.error)
      assert.equal(operation.result?.removed_count, 1)
    } finally {
      restore()
    }
    assert.equal(checkedAdmission, true)
    assert.equal(existsSync(image), false)
  })

  test('refuses a file replaced after review without removing it', async () => {
    const episode = await seedEpisode('EP0001')
    const image = path.join(episode.paths.bg_dir, 'scene.png')
    await fs.writeFile(image, 'reviewed')
    await makeOlder(image)
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['images'])
    await fs.writeFile(image, 'replacement')

    const operation = await run(bill.preview_id, 'remove')

    assert.equal(operation.status, 'completed', operation.error)
    assert.equal(operation.result?.removed_count, 0)
    assert.equal(operation.result?.skipped_count, 1)
    assert.equal(await fs.readFile(image, 'utf8'), 'replacement')
  })

  test('archive refuses collisions and keeps the reviewed source', async () => {
    const episode = await seedEpisode('EP0001')
    const audio = path.join(episode.paths.audio_dir, 'chapter-01.mp3')
    await fs.writeFile(audio, 'audio')
    await makeOlder(audio)
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['chapter_audio'])
    const destination = path.join(tmp.dir, 'archive')
    const target = cleanup.archiveDestinationFor(destination, SLUG, episode.code, bill.files[0]!)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'already here')

    const operation = await run(bill.preview_id, 'archive', destination)

    assert.equal(operation.status, 'completed', operation.error)
    assert.equal(operation.result?.archived_count, 0)
    assert.equal(operation.result?.skipped_count, 1)
    assert.equal(await fs.readFile(audio, 'utf8'), 'audio')
    assert.equal(await fs.readFile(target, 'utf8'), 'already here')
  })

  test('archive rejects a symbolic-link destination before copying', async () => {
    const episode = await seedEpisode('EP0001')
    const audio = path.join(episode.paths.audio_dir, 'chapter-01.mp3')
    await fs.writeFile(audio, 'audio')
    await makeOlder(audio)
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['chapter_audio'])
    const physical = path.join(tmp.dir, 'physical-archive')
    const linked = path.join(tmp.dir, 'linked-archive')
    await fs.mkdir(physical)
    await fs.symlink(physical, linked)

    await assert.rejects(
      cleanup.startMediaCleanupRun(SLUG, { preview_id: bill.preview_id, mode: 'archive', destination: linked }),
      /symbolic link/i,
    )
    assert.equal(await fs.readFile(audio, 'utf8'), 'audio')
  })

  test('archive copies and verifies on the same disk without claiming net space reclaimed', async () => {
    const episode = await seedEpisode('EP0001')
    const audio = path.join(episode.paths.audio_dir, 'chapter-01.mp3')
    await fs.writeFile(audio, 'audio')
    await makeOlder(audio)
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['chapter_audio'])
    const destination = path.join(tmp.dir, 'archive')
    const target = cleanup.archiveDestinationFor(destination, SLUG, episode.code, bill.files[0]!)
    assert.match(target, new RegExp(`${SLUG}[\\\\/]${episode.code}[\\\\/]`))

    const operation = await run(bill.preview_id, 'archive', destination)

    assert.equal(operation.status, 'completed', operation.error)
    assert.equal(operation.result?.archived_count, 1)
    assert.equal(operation.result?.bytes_moved, 5)
    assert.equal(operation.result?.bytes_reclaimed, 0)
    assert.equal(existsSync(audio), false)
    assert.equal(await fs.readFile(target, 'utf8'), 'audio')
    const status = await cleanup.readLocalMediaCleanupStatus(SLUG, 'EP0001')
    assert.equal(status.state, 'archived')
  })

  test('archive verifies copied bytes before recording or removing the source', async () => {
    const episode = await seedEpisode('EP0001')
    const audio = path.join(episode.paths.audio_dir, 'chapter-01.mp3')
    await fs.writeFile(audio, 'source bytes')
    await makeOlder(audio)
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['chapter_audio'])
    const restore = cleanup._setMediaCleanupHooksForTests({
      afterArchiveCopy: async (_source, target) => { await fs.writeFile(target, 'source bytez') },
    })
    try {
      const operation = await run(bill.preview_id, 'archive', path.join(tmp.dir, 'archive'))
      assert.equal(operation.status, 'completed', operation.error)
      assert.equal(operation.result?.failed_count, 1)
      assert.equal(await fs.readFile(audio, 'utf8'), 'source bytes')
      const status = await cleanup.readLocalMediaCleanupStatus(SLUG, 'EP0001')
      assert.equal(status.has_retired_media, false)
    } finally {
      restore()
    }
  })

  test('malformed cleanup history fails closed and leaves reviewed media in place', async () => {
    const episode = await seedEpisode('EP0001')
    const image = path.join(episode.paths.bg_dir, 'scene.png')
    await fs.writeFile(image, 'scene')
    await makeOlder(image)
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['images'])
    await fs.writeFile(path.join(episode.paths.episode_dir, cleanup.MEDIA_CLEANUP_SIDECAR), '{"version":1,"entries":')

    const operation = await run(bill.preview_id, 'remove')

    assert.equal(operation.status, 'completed', operation.error)
    assert.equal(operation.result?.failed_count, 1)
    assert.equal(await fs.readFile(image, 'utf8'), 'scene')
    const status = await cleanup.readLocalMediaCleanupStatus(SLUG, 'EP0001')
    assert.equal(status.has_retired_media, false)
    assert.match(status.blocked_reason || '', /unreadable/i)
  })

  test('stop finishes the current file and leaves later reviewed files untouched', async () => {
    const episode = await seedEpisode('EP0001')
    const one = path.join(episode.paths.audio_dir, 'chapter-01.mp3')
    const two = path.join(episode.paths.audio_dir, 'chapter-02.mp3')
    await fs.writeFile(one, 'one')
    await fs.writeFile(two, 'two')
    await Promise.all([one, two].map(makeOlder))
    await markUploaded(episode)
    const bill = await preview(['EP0001'], ['chapter_audio'])
    let operationId = ''
    const restore = cleanup._setMediaCleanupHooksForTests({
      afterFile: async () => { cleanup.stopMediaCleanupOperation(SLUG, operationId) },
    })
    try {
      const started = await cleanup.startMediaCleanupRun(SLUG, {
        preview_id: bill.preview_id, mode: 'remove',
      })
      operationId = started.operation_id
      const operation = await waitForOperation(operationId)
      assert.equal(operation.status, 'stopped')
      assert.equal(operation.result?.removed_count, 1)
      assert.equal([existsSync(one), existsSync(two)].filter(Boolean).length, 1)
      const sidecar = JSON.parse(await fs.readFile(path.join(episode.paths.episode_dir, cleanup.MEDIA_CLEANUP_SIDECAR), 'utf8'))
      assert.equal(sidecar.entries.filter((entry: any) => entry.outcome === 'removed').length, 1)
      assert.equal(sidecar.entries.filter((entry: any) => entry.outcome.startsWith('pending')).length, 0)
    } finally {
      restore()
    }
  })
})

test('media cleanup routes acknowledge long work and expose project-scoped operation status', async () => {
  const episode = await seedEpisode('EP0001')
  const image = path.join(episode.paths.bg_dir, 'scene.png')
  await fs.writeFile(image, 'scene')
  await makeOlder(image)
  await markUploaded(episode)
  const { router } = await import('../routes/media-cleanup.js')
  const app = express()
  app.use(express.json())
  app.use('/api', router)

  const started = await request(app)
    .post(`/api/projects/${SLUG}/media-cleanup/preview`)
    .send({ episode_codes: ['EP0001'], categories: ['images'] })
    .expect(202)
  assert.equal(typeof started.body.operation_id, 'string')

  const operation = await waitForOperation(started.body.operation_id)
  const status = await request(app)
    .get(`/api/projects/${SLUG}/media-cleanup/operations/${started.body.operation_id}`)
    .expect(200)
  assert.equal(status.body.status, operation.status)
  assert.equal(status.body.preview.files.length, 1)
  await request(app)
    .get(`/api/projects/another-project/media-cleanup/operations/${started.body.operation_id}`)
    .expect(404)
})
