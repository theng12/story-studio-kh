import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const im = await import('../services/idea-manager.js')
const { readEpisodeUploadStatus } = await import('../services/episode-upload-status.js')
const { readYouTubeRetentionStores } = await import('../services/youtube-remote-video.js')
const { resolveEpisodePaths } = await import('../services/utils.js')
const { router } = await import('../routes/ideas.js')
after(async () => { await temp.cleanup() })
const NOW = '2026-10-06T00:00:00.000Z'

test('saved successful upload survives local final removal without making publishing a generation requirement', async () => {
  const project = await pm.createProject({ name: 'Durable Upload Board' })
  const [idea] = await im.addIdeas(project.slug, [{ title: 'First', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test')
  await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const paths = await resolveEpisodePaths(project.slug, 'EP0001', 'First')
  const final = path.join(paths.video_dir, 'EP0001_final_video.mp4')
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(final, 'local final bytes')
  const record = {
    schema_version: 1, revision: 1, operation_id: 'saved-upload', project_slug: project.slug,
    episode_code: 'EP0001', channel_id: 'channel-1', source_revision: 'source-1', metadata_revision: 'metadata-1',
    created_at: NOW, updated_at: NOW, lifecycle: 'ready', video_id: 'video-1', accepted_at: NOW,
    playlists: {}, drift: {}, actions: [], origin: 'manual', final_action: 'manual_upload',
    remote_snapshot: { fetched_at: NOW, title: 'First', description: '', tags: [], privacy_status: 'unlisted', scheduled_for: null },
  }
  const operation = path.join(pm.getProjectDir(project.slug)!, 'youtube', 'operations', 'saved-upload.json')
  await fs.mkdir(path.dirname(operation), { recursive: true })
  await fs.writeFile(operation, JSON.stringify(record))
  const before = await fs.readFile(operation)
  const read = async () => readEpisodeUploadStatus(project.slug, 'EP0001', 'First', await readYouTubeRetentionStores(project.slug))
  const status = await read()
  assert.equal(status.state, 'uploaded')
  assert.equal(status.visibility, 'unlisted')
  await fs.mkdir(path.join(temp.dir, '_trash'), { recursive: true })
  await fs.rename(final, path.join(temp.dir, '_trash', 'original-final.mp4'))
  assert.deepEqual(await read(), status)
  assert.deepEqual(await fs.readFile(operation), before)
  const app = express().use(router)
  const response = await request(app).get(`/projects/${project.slug}/episodes`)
  assert.equal(response.status, 200)
  assert.equal(response.body[0].youtube_upload.state, 'uploaded')
  assert.equal(response.body[0].status.all_done, false, 'upload cannot fill missing generation stages')
  await fs.writeFile(operation, '{broken:')
  const damaged = await request(app).get(`/projects/${project.slug}/episodes?refresh=1`)
  assert.equal(damaged.status, 200, 'unreadable publishing history cannot block generation status')
  assert.equal(damaged.body[0].youtube_upload.state, 'unknown')
  assert.equal(await fs.readFile(operation, 'utf8'), '{broken:', 'a read must preserve damaged evidence')
})

test('pending, failed, accepted and terminal queue flags cannot masquerade as successful uploads', async () => {
  const project = await pm.createProject({ name: 'Upload States' })
  const base: any = { schema_version: 1, revision: 1, operation_id: 'one', project_slug: project.slug, episode_code: 'EP0001', channel_id: 'channel-1', source_revision: 'source-1', metadata_revision: 'metadata-1', created_at: NOW, updated_at: NOW, playlists: {}, drift: {}, actions: [], origin: 'manual', final_action: 'manual_upload' }
  for (const [lifecycle, expected] of [['preparing', 'uploading'], ['uploading', 'uploading'], ['accepted', 'processing'], ['processing', 'processing'], ['failed', 'failed'], ['rejected', 'failed'], ['status_unavailable', 'unknown']]) {
    const record = { ...base, lifecycle, ...(lifecycle === 'preparing' || lifecycle === 'uploading' ? {} : { video_id: 'video-1', accepted_at: NOW }) }
    const status = await readEpisodeUploadStatus(project.slug, 'EP0001', '', { records: [record], state: { episode_video_links: {} } })
    assert.equal(status.state, expected, lifecycle)
  }
  for (const [jobState, expected] of [['queued', 'queued'], ['running', 'uploading'], ['error', 'failed'], ['done', 'pending']]) {
    assert.equal((await readEpisodeUploadStatus(project.slug, 'EP0001', '', { records: [], state: { episode_video_links: {} } }, undefined, { status: jobState } as any)).state, expected)
  }
  assert.equal((await readEpisodeUploadStatus(project.slug, 'EP0001', '', { records: [{ ...base, lifecycle: 'preparing' }], state: { episode_video_links: {} } }, undefined, { status: 'queued' } as any)).state, 'queued', 'pre-created receipt does not mean its queued job has started')
  assert.equal((await readEpisodeUploadStatus(project.slug, 'EP0001', '', { records: [{ ...base, lifecycle: 'preparing' }], state: { episode_video_links: {} } }, undefined, { status: 'error', error: 'Upload connection failed.' } as any)).state, 'failed', 'a failed job must not look active because its preparation receipt remains')
})

test('owner-linked identities stay unverified until a provider publication receipt exists', async () => {
  const project = await pm.createProject({ name: 'Linked Upload' })
  const link: any = { channel_id: 'channel-1', video_id: 'linked-video', linked_at: NOW, source: 'reconcile' }
  const stores = { records: [], state: { episode_video_links: { EP0001: link } } }
  const unverified = await readEpisodeUploadStatus(project.slug, 'EP0001', '', stores)
  assert.equal(unverified.state, 'recorded')
  assert.equal(unverified.checked_at, undefined)
  link.publication = { verified_at: NOW, privacy_status: 'private', scheduled_for: '2026-10-07T00:00:00.000Z' }
  const verified = await readEpisodeUploadStatus(project.slug, 'EP0001', '', stores)
  assert.equal(verified.state, 'uploaded')
  assert.equal(verified.visibility, 'private')
  assert.equal(verified.scheduled_for, link.publication.scheduled_for)
  const paths = await resolveEpisodePaths(project.slug, 'EP0002', 'Legacy')
  await fs.mkdir(paths.episode_dir, { recursive: true })
  await fs.writeFile(path.join(paths.episode_dir, 'youtube_upload.json'), JSON.stringify({ video_id: 'legacy-1', channel_id: 'channel-1', uploaded_at: NOW }))
  const legacy = await readEpisodeUploadStatus(project.slug, 'EP0002', 'Legacy', { records: [], state: { episode_video_links: {} } })
  assert.equal(legacy.state, 'recorded')
  assert.equal(legacy.source, 'legacy_sidecar')
  assert.equal(legacy.checked_at, undefined, 'legacy/imported identity is not a fresh remote verification')
})

test('episode rows show the latest upload attempt rather than queue display order', async () => {
  const project = await pm.createProject({ name: 'Latest Upload Attempt' })
  const [idea] = await im.addIdeas(project.slug, [{ title: 'Latest', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test')
  await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const jq = await import('../services/job-queue.js')
  for (const [job_id, status, created_at] of [['old-done', 'done', '2026-10-05T00:00:00.000Z'], ['latest-failed', 'error', NOW]] as const) {
    await jq.writeAuthoritativeJob({
      job_id, project_slug: project.slug, type: 'youtube_upload', episode_id: 'EP0001', title: 'Latest', status,
      created_at, started_at: created_at, finished_at: created_at, error: status === 'error' ? 'Upload connection failed.' : null,
      output_lines: [], params: {}, progress: 0,
    } as any)
  }
  const response = await request(express().use(router)).get(`/projects/${project.slug}/episodes`)
  assert.equal(response.status, 200)
  assert.equal(response.body[0].youtube_upload.state, 'failed')
  assert.equal(response.body[0].youtube_upload.reason, 'Upload connection failed.')
})

test('the episode list serialises only upload jobs, never the whole job history', async () => {
  const project = await pm.createProject({ name: 'Large History Upload List' })
  const [idea] = await im.addIdeas(project.slug, [{ title: 'Big', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test')
  await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const jq = await import('../services/job-queue.js')
  const job = (job_id: string, type: string, status: string, created_at: string) => ({
    job_id, project_slug: project.slug, type, episode_id: 'EP0001', title: 'Big', status,
    created_at, started_at: created_at, finished_at: created_at, error: status === 'error' ? 'Upload connection failed.' : null,
    output_lines: [], params: {}, progress: 0,
  } as any)
  for (let i = 0; i < 40; i++) await jq.writeAuthoritativeJob(job(`render-${i}`, 'continuity_render', 'done', NOW))
  await jq.writeAuthoritativeJob(job('upload-old', 'youtube_upload', 'done', '2026-10-05T00:00:00.000Z'))
  await jq.writeAuthoritativeJob(job('upload-new', 'youtube_upload', 'error', NOW))
  const expected = (await jq.getJobs(project.slug)).filter(row => row.type === 'youtube_upload')
  assert.deepEqual(await jq.getJobs(project.slug, 'youtube_upload'), expected, 'the filtered read returns the same public rows')

  jq._resetJobPersistenceCountersForTesting()
  const response = await request(express().use(router)).get(`/projects/${project.slug}/episodes?refresh=1`)
  assert.equal(response.status, 200)
  assert.equal(response.body[0].youtube_upload.state, 'failed')
  assert.equal(jq._getJobPersistenceCountersForTesting().public_serializations, 2, 'only the two upload jobs are serialised')
})
