import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { createProject } from '../services/project-manager.js'
import { assignProjectYouTubeChannel, configureYouTubeApplication } from '../services/youtube-connection-store.js'
import { acceptYouTubeOperation, createYouTubeOperation, readYouTubeOperation } from '../services/youtube-operation-store.js'
import { generateYoutubePlaylistUpdate } from '../generators/youtube-playlist-update.js'

let cleanup: (() => Promise<void>) | undefined
const CHANNEL = 'UC-playlist'

async function setup() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Canonical Playlist' })
  await fs.writeFile(path.join(temp.dir, 'projects', project.slug, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', episode_code: 'EP0001', title: 'Episode One', status: 'accepted' }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  await configureYouTubeApplication({ client_id: 'playlist-client', client_secret: 'playlist-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Playlist Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'playlist-access', refresh_token: 'playlist-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null })
  const payload = {
    snippet_json: JSON.stringify({ title: 'Episode One', description: '', tags: [], categoryId: '24' }),
    status_json: JSON.stringify({ privacyStatus: 'private' }),
    source_sha256: 'a'.repeat(64),
  }
  const opened = await createYouTubeOperation({
    project_slug: project.slug, episode_code: 'EP0001', channel_id: CHANNEL,
    source_revision: 'source-1', metadata_revision: 'metadata-1', final_payload: payload,
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await acceptYouTubeOperation({
    project_slug: project.slug, operation_id: opened.operation_id, expected_revision: opened.revision,
    channel_id: CHANNEL, video_id: 'video-1', accepted_at: new Date().toISOString(), final_payload: payload,
  })
  return { slug: project.slug, operationId: accepted.operation_id }
}

afterEach(async () => { await cleanup?.(); cleanup = undefined })

test('a canonical operation with no legacy sidecar reaches playlist membership and checkpoints the operation', async () => {
  const { slug, operationId } = await setup()
  const calls: unknown[] = []
  const job = {
    job_id: 'playlist-job', project_slug: slug, episode_id: 'EP0001', output_lines: [],
    params: { episode_id: 'EP0001', account_id: `registry:${CHANNEL}`, playlist_id: 'playlist-1' },
  } as any
  await generateYoutubePlaylistUpdate(job, {
    ensureMembership: (async (input: unknown) => { calls.push(input); return { inserted: true } }) as any,
  })
  assert.equal(calls.length, 1)
  assert.equal((calls[0] as { videoId: string }).videoId, 'video-1')
  assert.equal((await readYouTubeOperation(slug, operationId))?.playlists['playlist-1']?.state, 'present')
})

test('a provider failure is recorded and remains retryable through remote verification', async () => {
  const { slug, operationId } = await setup()
  const job = {
    job_id: 'playlist-fail', project_slug: slug, episode_id: 'EP0001', output_lines: [],
    params: { episode_id: 'EP0001', account_id: `registry:${CHANNEL}`, playlist_id: 'playlist-1' },
  } as any
  await assert.rejects(generateYoutubePlaylistUpdate(job, {
    ensureMembership: (async () => { throw Object.assign(new Error('provider refused'), { code: 'provider_refused' }) }) as any,
  }), /provider refused/)
  assert.equal((await readYouTubeOperation(slug, operationId))?.playlists['playlist-1']?.state, 'failed')
})
