import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectTimelineEpisode } from '../services/publishing-timeline.js'
import type { Job } from '../models/types.js'
import type { EpisodeStatus } from '../services/asset-status.js'
const now = Date.parse('2026-11-09T12:00:00Z')
const base = { id: 'idea1', code: 'EP0001', title: 'A story', slug: 'alpha', now }
const job = (patch: Partial<Job>): Job => ({ episode_id: base.code, created_at: '2026-11-09T00:00:00Z', type: 'video_assembly', title: 'Render', status: 'running', started_at: null, error: null, ...patch } as Job)

test('upload start is the recorded start, never the release plan or enqueue time', () => {
  const episode = projectTimelineEpisode({ ...base, plannedAt: '2026-11-12T10:00:00Z', uploadJob: job({ type: 'youtube_upload', status: 'queued' }) })
  assert.equal(episode.upload_start_at, null)
  assert.equal(episode.public_release_at, '2026-11-12T10:00:00Z')
  assert.equal(episode.date_source, 'planned')
  const started = projectTimelineEpisode({ ...base, uploadJob: job({ type: 'youtube_upload', started_at: '2026-11-09T11:00:00Z' }) })
  assert.equal(started.upload_start_at, '2026-11-09T11:00:00Z')
})
test('a completed job never proves final artifacts', () => {
  const episode = projectTimelineEpisode({ ...base, stepJob: job({ status: 'done' }) })
  assert.notEqual(episode.stage, 'final')
  assert.notEqual(episode.state, 'complete')
  assert.equal(projectTimelineEpisode({ ...base, final: true }).stage, 'final')
})
test('partial or unreadable artifacts remain not checked', () => {
  assert.equal(projectTimelineEpisode({ ...base, assets: { _unreliable: true, script: true } as EpisodeStatus }).state, 'not_checked')
  assert.equal(projectTimelineEpisode({ ...base, error: 'Drive unavailable' }).detail, 'Drive unavailable')
  assert.equal(projectTimelineEpisode({ ...base, assets: { scene_review: false, images: false } as EpisodeStatus }).state, 'waiting')
})
test('failed and paused renders stay loud even when an older final exists', () => {
  const failed = projectTimelineEpisode({ ...base, final: true, stepJob: job({ status: 'error', error: 'Missing scene 4\nprivate diagnostics' }) })
  assert.equal(failed.stage, 'render'); assert.equal(failed.state, 'failed'); assert.equal(failed.detail, 'Missing scene 4')
  assert.equal(projectTimelineEpisode({ ...base, stepJob: job({ status: 'paused' }) }).state, 'paused')
})
test('undated accepted ideas remain undated', () => {
  const episode = projectTimelineEpisode({ ...base, code: '' })
  assert.equal(episode.stage, 'idea'); assert.equal(episode.upload_start_at, null); assert.equal(episode.public_release_at, null)
  assert.equal(episode.id, 'idea1')
})
test('an uploaded identity alone proves neither public nor scheduled', () => {
  const episode = projectTimelineEpisode({ ...base, remoteVideoId: 'video', plannedAt: '2026-11-12T10:00:00Z' })
  assert.equal(episode.stage, 'uploaded'); assert.equal(episode.public_release_at, null)
  const listing = projectTimelineEpisode({ ...base, remoteVideoId: 'video', observation: { video_id: 'video', source: 'channel_listing', privacy_status: 'public', published_at: '2026-11-08T10:00:00Z' } })
  assert.equal(listing.stage, 'uploaded'); assert.equal(listing.publication_freshness, 'unknown')
})
test('fresh checked publication supersedes local intent and dates stay separate', () => {
  const episode = projectTimelineEpisode({ ...base, remoteVideoId: 'video', plannedAt: '2026-11-20T10:00:00Z', observation: { video_id: 'video', source: 'operation', checked_at: '2026-11-09T11:59:00Z', privacy_status: 'private', scheduled_for: '2026-11-12T10:00:00Z' } })
  assert.equal(episode.stage, 'scheduled'); assert.equal(episode.date_source, 'confirmed'); assert.equal(episode.public_release_at, '2026-11-12T10:00:00Z'); assert.equal(episode.upload_start_at, null)
})
test('stale public observations retain their evidence without claiming current success', () => {
  const episode = projectTimelineEpisode({ ...base, remoteVideoId: 'video', observation: { video_id: 'video', source: 'operation', checked_at: '2026-10-01T10:00:00Z', privacy_status: 'public', published_at: '2026-09-30T10:00:00Z' } })
  assert.equal(episode.stage, 'public'); assert.equal(episode.state, 'not_checked'); assert.equal(episode.publication_freshness, 'stale'); assert.match(episode.detail, /stale/)
})
test('provider failures and foreign-channel evidence never become public', () => {
  for (const upload_status of ['failed', 'rejected', 'not_found']) {
    const episode = projectTimelineEpisode({ ...base, remoteVideoId: 'video', observation: { video_id: 'video', source: 'operation', upload_status, checked_at: '2026-11-09T11:59:00Z', privacy_status: 'public' } })
    assert.notEqual(episode.stage, 'public'); assert.notEqual(episode.state, 'complete')
  }
  const other = projectTimelineEpisode({ ...base, remoteVideoId: 'video', otherChannel: true, observation: { video_id: 'video', source: 'operation', checked_at: '2026-11-09T11:59:00Z', privacy_status: 'public' } })
  assert.equal(other.stage, 'uploaded'); assert.match(other.detail, /another/)
})
