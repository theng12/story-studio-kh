import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'

import { useTempDataDir } from './_helpers.js'

const realFetch = globalThis.fetch
const ACCOUNT_ID = 'youtube-publishing-safety-account'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let store: typeof import('../services/upload-store.js')
let sidecars: typeof import('../services/upload-sidecar.js')
let playlistSync: typeof import('../services/youtube-playlist-sync.js')
let youtube: typeof import('../lib/youtube-client.js')
let utils: typeof import('../services/utils.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  store = await import('../services/upload-store.js')
  sidecars = await import('../services/upload-sidecar.js')
  playlistSync = await import('../services/youtube-playlist-sync.js')
  youtube = await import('../lib/youtube-client.js')
  utils = await import('../services/utils.js')
})

after(async () => {
  globalThis.fetch = realFetch
  await cleanup()
})

beforeEach(async () => {
  globalThis.fetch = realFetch
  await fs.rm(path.join(tempDir, 'projects'), { recursive: true, force: true })
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
})

async function seedProject(): Promise<string> {
  const project = await pm.createProject({ name: 'YouTube Publishing Safety' })
  await store.writeOAuthClient(project.slug, 'youtube', {
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
  })
  await store.writeTokens(project.slug, 'youtube', ACCOUNT_ID, {
    access_token: 'fresh-access-token',
    refresh_token: 'refresh-token',
    expires_at: Date.now() + 60 * 60_000,
    scope: 'https://www.googleapis.com/auth/youtube',
  })
  await pm.updateConfig(project.slug, {
    upload_default_account: { youtube: ACCOUNT_ID },
    upload_accounts: {
      youtube: [{
        id: ACCOUNT_ID,
        platform: 'youtube',
        label: 'Test',
        remote_id: 'UC_test',
        remote_title: 'Test',
        connected_at: new Date().toISOString(),
      }],
    },
  } as any)
  return project.slug
}

function completeSidecar(overrides: Partial<import('../services/upload-sidecar.js').UploadSidecar> = {}) {
  return {
    platform: 'youtube' as const,
    video_id: 'video-1',
    account_id: ACCOUNT_ID,
    channel_id: 'UC_test',
    uploaded_at: '2026-07-16T00:00:00.000Z',
    last_sync_at: '2026-07-16T00:00:00.000Z',
    scheduled_for: null,
    privacy_status: 'private' as const,
    title: 'Episode',
    description: 'Description',
    tags: ['story'],
    thumbnail_set: true,
    ...overrides,
  }
}

describe('YouTube playlist quota safety', () => {
  it('skips the 50-unit insert when membership already exists', async () => {
    let inserts = 0
    const result = await playlistSync.ensureYoutubePlaylistMembership(
      { slug: 'p', accountId: 'a', playlistId: 'pl', videoId: 'v' },
      {
        isMember: async () => true,
        insert: async () => { inserts++ },
      },
    )
    assert.deepEqual(result, { inserted: false, verified: true })
    assert.equal(inserts, 0)
  })

  it('inserts once and verifies the remote membership afterward', async () => {
    const membership = [false, true]
    let inserts = 0
    const result = await playlistSync.ensureYoutubePlaylistMembership(
      { slug: 'p', accountId: 'a', playlistId: 'pl', videoId: 'v' },
      {
        isMember: async () => membership.shift() ?? false,
        insert: async () => { inserts++ },
      },
    )
    assert.deepEqual(result, { inserted: true, verified: true })
    assert.equal(inserts, 1)
    assert.deepEqual(membership, [])
  })

  it('fails loudly when the provider response is not reflected remotely', async () => {
    let inserts = 0
    await assert.rejects(
      playlistSync.ensureYoutubePlaylistMembership(
        { slug: 'p', accountId: 'a', playlistId: 'pl', videoId: 'v' },
        {
          isMember: async () => false,
          insert: async () => { inserts++ },
        },
      ),
      /not present in playlist/,
    )
    assert.equal(inserts, 1)
  })

  it('honours cancellation before a playlist insert', async () => {
    let checks = 0
    let inserts = 0
    await assert.rejects(
      playlistSync.ensureYoutubePlaylistMembership(
        {
          slug: 'p', accountId: 'a', playlistId: 'pl', videoId: 'v',
          isCancelled: () => checks++ > 0,
        },
        {
          isMember: async () => false,
          insert: async () => { inserts++ },
        },
      ),
      /Cancelled by user before playlist insertion/,
    )
    assert.equal(inserts, 0)
  })

  it('queries YouTube with both playlist and video IDs', async () => {
    const slug = await seedProject()
    let requested = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input)
      return new Response(JSON.stringify({ items: [{ id: 'playlist-item-1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    assert.equal(await youtube.isVideoInPlaylist({
      slug,
      accountId: ACCOUNT_ID,
      playlistId: 'playlist-1',
      videoId: 'video-1',
    }), true)
    const url = new URL(requested)
    assert.equal(url.searchParams.get('playlistId'), 'playlist-1')
    assert.equal(url.searchParams.get('videoId'), 'video-1')
    assert.equal(url.searchParams.get('maxResults'), '1')
  })
})

describe('YouTube publishing checkpoints', () => {
  it('rejects incomplete or mismatched upload identities', () => {
    assert.deepEqual(sidecars.inspectUploadSidecarIdentity(completeSidecar(), {
      platform: 'youtube', video_id: 'video-1', account_id: ACCOUNT_ID, channel_id: 'UC_test',
    }), [])
    assert.deepEqual(sidecars.inspectUploadSidecarIdentity(completeSidecar({ video_id: '' }), {
      platform: 'youtube', video_id: 'video-1', account_id: ACCOUNT_ID, channel_id: 'UC_test',
    }), ['video_id is empty'])
  })

  it('writes and re-reads a permanent upload identity before post-upload work', async () => {
    const slug = await seedProject()
    const checkpoint = await sidecars.checkpointUploadSidecarIdentity(
      slug,
      'EP0001',
      'Episode',
      completeSidecar(),
    )
    assert.deepEqual(checkpoint.invalid, [])
    assert.equal(checkpoint.saved?.video_id, 'video-1')
    assert.equal(checkpoint.saved?.account_id, ACCOUNT_ID)
    assert.equal(checkpoint.saved?.channel_id, 'UC_test')
  })

  it('checkpoints playlist membership without losing a concurrent schedule update', async () => {
    const slug = await seedProject()
    await sidecars.writeSidecar(slug, 'EP0001', 'Episode', completeSidecar())
    const scheduled = '2026-08-01T12:00:00.000Z'

    await Promise.all([
      sidecars.checkpointPlaylistSync(slug, 'EP0001', 'Episode', {
        playlist_id: 'playlist-1', video_id: 'video-1', account_id: ACCOUNT_ID,
      }),
      sidecars.setScheduledFor(slug, 'EP0001', 'Episode', 'youtube', scheduled),
    ])

    const saved = await sidecars.readSidecar(slug, 'EP0001', 'Episode', 'youtube')
    assert.equal(saved?.scheduled_for, scheduled)
    assert.deepEqual(sidecars.inspectPlaylistSyncCheckpoint(saved, {
      playlist_id: 'playlist-1', video_id: 'video-1', account_id: ACCOUNT_ID,
    }), [])
  })

  it('refuses to checkpoint a playlist against a changed remote video', async () => {
    const slug = await seedProject()
    await sidecars.writeSidecar(slug, 'EP0001', 'Episode', completeSidecar({ video_id: 'new-video' }))
    await assert.rejects(
      sidecars.checkpointPlaylistSync(slug, 'EP0001', 'Episode', {
        playlist_id: 'playlist-1', video_id: 'old-video', account_id: ACCOUNT_ID,
      }),
      /Upload record changed/,
    )
  })

  it('checkpoints a verified thumbnail without losing playlist or schedule state', async () => {
    const slug = await seedProject()
    await sidecars.writeSidecar(slug, 'EP0001', 'Episode', completeSidecar({
      thumbnail_set: false,
      scheduled_for: '2026-08-01T12:00:00.000Z',
      playlist_sync: {
        'playlist-1': { video_id: 'video-1', account_id: ACCOUNT_ID, verified_at: '2026-07-16T00:00:00.000Z' },
      },
    }))
    const paths = await utils.resolveEpisodePaths(slug, 'EP0001', 'Episode')
    const sidecarPath = path.join(paths.episode_dir, 'youtube_upload.json')
    const started = new Date(Date.now() - 1000).toISOString()

    await sidecars.checkpointThumbnailStateAtPath(
      sidecarPath,
      { video_id: 'video-1', account_id: ACCOUNT_ID },
      { set: true, remotely_verified: true },
    )
    const audit = await sidecars.auditThumbnailCheckpointAtPath(sidecarPath, {
      video_id: 'video-1', account_id: ACCOUNT_ID, verified_after: started,
    })
    assert.deepEqual(audit.invalid, [])
    assert.equal(audit.sidecar?.scheduled_for, '2026-08-01T12:00:00.000Z')
    assert.ok(audit.sidecar?.playlist_sync?.['playlist-1'])
  })

  it('refuses to checkpoint a thumbnail against a changed remote video', async () => {
    const slug = await seedProject()
    await sidecars.writeSidecar(slug, 'EP0001', 'Episode', completeSidecar({ video_id: 'new-video' }))
    const paths = await utils.resolveEpisodePaths(slug, 'EP0001', 'Episode')
    const sidecarPath = path.join(paths.episode_dir, 'youtube_upload.json')
    await assert.rejects(
      sidecars.checkpointThumbnailStateAtPath(
        sidecarPath,
        { video_id: 'old-video', account_id: ACCOUNT_ID },
        { set: true, remotely_verified: true },
      ),
      /Upload record changed/,
    )
  })
})
