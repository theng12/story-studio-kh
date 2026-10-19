/**
 * Regression for a surviving completion-review finding — 2026-10-19
 * (upload/provider review, publishing-identity area).
 *
 * FINDING: the duplicate-upload guard reads a TRUNCATED channel listing as a
 * complete one, so a second public video carrying the episode's title can be
 * admitted.
 *
 * `assertSafeToUploadAgain` (services/youtube-publication-status.ts:408-436)
 * asks for the channel's recent uploads with a bounded page budget and then
 * asserts an absolute claim:
 *     uploads = await listRecentUploads(..., { maxPages: 10 })      (line 421)
 *     const twin = uploads.videos.find(...)                          (line 431)
 * `uploads.truncated` is never read. But `listRecentUploads`
 * (lib/youtube-client.ts:1487-1522) returns `truncated: true` precisely when
 * the budget ran out while YouTube still had more (lines 1519-1521), and its
 * doc comment says a listing "cut off at the page budget is a truncation
 * signal, never a complete answer". Every OTHER caller honours it — the
 * reconcile route propagates it as `outcome: 'partial'` /
 * `remote_listing_truncated` (routes/youtube-upload-center.ts:1347,1386,1392).
 *
 * CONSEQUENCE: on a channel with more than 500 uploads where a video carrying
 * the episode's title lies beyond the 500 most recent (and its id is not in
 * `input.video_ids` — the exact "not returned by videos.list" case the title
 * check exists for), the id check at line 425 passes, the title check cannot
 * see the twin, and the last gate before an upload resolves successfully — a
 * second public video with the same title. The repo's own stated preference
 * (services/youtube-remote-video.ts:431-432) is that a wrongly-allowed upload
 * is worse than a wrongly-refused one.
 *
 * COVERAGE: none. `__tests__/youtube-status-sync.test.ts:350-386` is the only
 * test of `assertSafeToUploadAgain`, and its `channelUploads` helper never sets
 * `nextPageToken`, so `truncated` is never true there.
 *
 * PLACEMENT: uses the application's own relative imports, so copy to
 * electron/server/__tests__/ before running against a release worktree.
 *
 * EXPECTED RED on the current source: the promise RESOLVES (upload allowed).
 * GREEN once truncation is treated as "could not fully check" and the guard
 * refuses (YOUTUBE_STATUS_UNCHECKED) — or as a possible twin
 * (YOUTUBE_ALREADY_PUBLISHED).
 *
 * FIXTURE CONTROLS (this revision). A bare `assert.rejects` could pass for the
 * WRONG reason: any setup failure (an unqueued transport call, a missing grant,
 * a thrown `playlistItems.list failed`) is wrapped by `unchecked(...)`
 * (lines 415-423) into `YOUTUBE_STATUS_UNCHECKED`, which `assert.rejects`
 * would accept — a false green. So the RED test now FIRST proves the code
 * really reached the truncation (exactly ten 200-status playlistItems GETs, one
 * channels read, one videos read, no POST) and only THEN asserts the refusal.
 * The GREEN control below is the same setup with a listing that COMPLETES
 * (no nextPageToken) and no twin: it must resolve, and must stop after one page.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
  registryCredentialFor,
} from '../lib/youtube-client.js'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

const CHANNEL = 'UC-truncated'
const CHANNELS = /^\/youtube\/v3\/channels\?/
const PLAYLIST_ITEMS = /^\/youtube\/v3\/playlistItems\?/
const VIDEOS = /^\/youtube\/v3\/videos\?part=snippet,status,processingDetails&id=/

async function connectedProject(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  const connections = await import('../services/youtube-connection-store.js')
  const project = await pm.createProject({ name: 'Truncated Listing' })
  await connections.configureYouTubeApplication({ client_id: 'trunc-client', client_secret: 'trunc-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Truncated Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'trunc-access', refresh_token: 'trunc-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null })
  return project.slug
}

function uploadInput(slug: string) {
  return {
    project_slug: slug,
    account_id: registryCredentialFor(CHANNEL),
    video_ids: ['vid-gone'],       // the id the episode is known by, no longer on YouTube
    titles: ['The Golden Mirror'], // the episode's title; the twin lives past the page budget
  }
}

test('RED: a truncated channel listing must not be read as proof that no twin title exists', async () => {
  const slug = await connectedProject()

  const fake = new FakeYouTube()
  fake.respondMatching({ method: 'GET', match: CHANNELS, body: {
    items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-list' } } }],
  } })
  // Ten full pages, each saying "there is more" — the page budget (maxPages: 10)
  // runs out with YouTube still holding more. The episode's title twin lives
  // beyond page 10, so it is never returned. `respondMatching` consumes one
  // pattern per call, so register one per page.
  for (let page = 0; page < 10; page++) {
    fake.respondMatching({ method: 'GET', match: PLAYLIST_ITEMS, body: {
      items: [{ snippet: { title: 'Another Episode', resourceId: { videoId: 'vid-other' } }, status: {} }],
      nextPageToken: `page-${page + 2}`,
    } })
  }
  // The id the episode is known by is NOT on YouTube any more.
  fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [] } })
  __setYouTubeTransportForTests(fake.transport())

  const { assertSafeToUploadAgain } = await import('../services/youtube-publication-status.js')
  let error: any
  try {
    await assertSafeToUploadAgain(uploadInput(slug))
    error = undefined
  } catch (caught) {
    error = caught
  }

  // 1. Prove the guard reached the truncation — the ten-page budget was really
  //    consumed with successful reads, so a refusal cannot be a setup failure.
  const getCalls = fake.calls.filter(call => call.method === 'GET')
  const playlistGets = getCalls.filter(call => PLAYLIST_ITEMS.test(call.path))
  const channelGets = getCalls.filter(call => CHANNELS.test(call.path))
  const videoGets = getCalls.filter(call => VIDEOS.test(call.path))
  const posts = fake.calls.filter(call => call.method !== 'GET')
  assert.equal(playlistGets.length, 10, 'the listing paged exactly to its 10-page budget')
  assert.ok(playlistGets.every(call => call.status === 200), 'every page answered 200, so the budget was reached rather than a transient failure')
  assert.equal(channelGets.length, 1, 'one channels read resolved the uploads playlist')
  assert.equal(videoGets.length, 1, 'one videos read checked the episode\'s known ids')
  assert.equal(getCalls.length, 12, 'exactly the three reads the guard needs, and nothing else')
  assert.equal(posts.length, 0, 'nothing was uploaded (no POST)')

  // 2. Only now, with the truncation proven: it is not proof the twin is absent.
  assert.ok(error, 'RED: the guard wrongly allowed the upload — a truncated listing cannot prove the title twin is absent')
  assert.ok(
    error.code === 'YOUTUBE_STATUS_UNCHECKED' || error.code === 'YOUTUBE_ALREADY_PUBLISHED',
    `expected the guard to refuse (YOUTUBE_STATUS_UNCHECKED or YOUTUBE_ALREADY_PUBLISHED), got ${error?.code}`,
  )
})

test('CONTROL: a complete listing with no twin title allows the upload and stops after one page', async () => {
  const slug = await connectedProject()

  const fake = new FakeYouTube()
  fake.respondMatching({ method: 'GET', match: CHANNELS, body: {
    items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-list' } } }],
  } })
  // ONE page, and NO nextPageToken: the listing completes, `truncated: false`.
  fake.respondMatching({ method: 'GET', match: PLAYLIST_ITEMS, body: {
    items: [{ snippet: { title: 'Another Episode', resourceId: { videoId: 'vid-other' } }, status: {} }],
  } })
  fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [] } })
  __setYouTubeTransportForTests(fake.transport())

  const { assertSafeToUploadAgain } = await import('../services/youtube-publication-status.js')
  await assertSafeToUploadAgain(uploadInput(slug))

  const playlistGets = fake.calls.filter(call => call.method === 'GET' && PLAYLIST_ITEMS.test(call.path))
  assert.equal(playlistGets.length, 1, 'a complete listing stops as soon as YouTube stops offering a next page')
})
