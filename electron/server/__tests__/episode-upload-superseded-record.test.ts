/**
 * Regression for a surviving completion-review finding — 2026-10-19
 * (upload/provider review, publishing-identity area).
 *
 * FINDING: the Production Board / episodes row reports a SUPERSEDED upload as
 * the episode's current state, because the operation arrays it reads are
 * oldest-first and it takes element [0].
 *
 * `readEpisodeUploadStatus` (services/episode-upload-status.ts:42,51) does:
 *     const ready    = evidence.ready_operations[0]
 *     const accepted = evidence.accepted_operations[0]
 * and maps `accepted` (line 52-57): lifecycle `failed`/`rejected` -> state
 * `failed`, and returns that record's `video_id`.
 *
 * Those arrays are built OLDEST-FIRST: `youtubeRetentionEvidenceFor`
 * (services/youtube-remote-video.ts:170-185) filters `all` in place, and `all`
 * is `listYouTubeOperations` index order — `youtube-operation-store.ts:585`
 * appends each new `operation_id` to the end of the index
 * (`[...loaded.index.operation_ids, candidate.operation_id]`), and
 * `readAllUnlocked` (lines 402-421) reads them in that order. So `[0]` is the
 * OLDEST record.
 *
 * CONSEQUENCE: an episode with a failed first attempt (video X) followed by a
 * live replacement (video Y) is shown as `failed`, pointing at the dead video
 * X — while the Upload Center `/publishable` route answers the same question
 * the other way: it takes the NEWEST non-superseded record
 * (routes/youtube-upload-center.ts:603 `records = newestOperations(...)`,
 * :690-691 `episodeOperations.find(r => !SUPERSEDED_LIFECYCLES.has(r.lifecycle))`).
 * Two screens disagree about one episode; §8 requires one shared rule. This
 * pair is newly reachable because of this release's SUPERSEDED_LIFECYCLES
 * change (contracts/youtube-upload-center.ts:67) — the Domnak DM0001–DM0003
 * replacement upload.
 *
 * COVERAGE: none. `__tests__/episode-upload-status.test.ts:61-65` feeds exactly
 * one record per lifecycle (`records: [record]`); no old-failed + new-live pair
 * exists anywhere.
 *
 * PLACEMENT: uses the application's own relative imports, so copy to
 * electron/server/__tests__/ before running against a release worktree.
 *
 * EXPECTED RED on the current source: state `failed`, video_id `video-X`.
 * GREEN once the row takes the newest (non-superseded) record: `processing`,
 * video_id `video-Y`.
 *
 * FIXTURE CONTROLS (this revision). The pair fixture is only meaningful if the
 * records actually reach `accepted_operations`, which `youtubeRetentionEvidenceFor`
 * filters by `isYouTubeVideoRemoved` (youtube-remote-video.ts:171). The pair's
 * `state` therefore carries NO `removed_videos`, and test 3 below proves the
 * filter is live by marking the live record removed and watching it drop out —
 * so the pair in test 1 is genuinely NOT marked removed. Test 2 is the normal
 * single/live positive control (one accepted record -> `processing`).
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const { readEpisodeUploadStatus } = await import('../services/episode-upload-status.js')
after(async () => { await temp.cleanup() })

const EARLIER = '2026-10-06T00:00:00.000Z'
const LATER = '2026-10-07T00:00:00.000Z'

const base = {
  schema_version: 1, revision: 1, episode_code: 'EP0001',
  channel_id: 'channel-1', source_revision: 's1', metadata_revision: 'm1',
  playlists: {}, drift: {}, actions: [], origin: 'manual', final_action: 'manual_upload',
}
const superseded = {
  ...base, operation_id: 'op-a', created_at: EARLIER, updated_at: EARLIER,
  lifecycle: 'failed', video_id: 'video-X', accepted_at: EARLIER,
}
const live = {
  ...base, operation_id: 'op-b', created_at: LATER, updated_at: LATER,
  lifecycle: 'accepted', video_id: 'video-Y', accepted_at: LATER,
}

test('RED: a failed first upload that was replaced must not be the episode\'s current state', async () => {
  const project = await pm.createProject({ name: 'Superseded Upload' })
  // The operation store returns records in creation order (oldest first), so the
  // array is [superseded, live] — exactly what readYouTubeRetentionStores yields.
  // `state` carries no `removed_videos`, so neither record is filtered out.
  const status = await readEpisodeUploadStatus(
    project.slug, 'EP0001', '',
    { records: [{ ...superseded, project_slug: project.slug }, { ...live, project_slug: project.slug }], state: { episode_video_links: {} } } as any,
  )
  assert.equal(status.state, 'processing', 'the replacement upload (video-Y) is the episode\'s current state')
  assert.equal(status.video_id, 'video-Y', 'the row must point at the live replacement, not the dead video-X')
})

test('CONTROL: a single live accepted upload reads as processing', async () => {
  const project = await pm.createProject({ name: 'Single Live Upload' })
  const status = await readEpisodeUploadStatus(
    project.slug, 'EP0001', '',
    { records: [{ ...live, project_slug: project.slug }], state: { episode_video_links: {} } } as any,
  )
  assert.equal(status.state, 'processing', 'one live accepted record is the episode\'s current state')
  assert.equal(status.video_id, 'video-Y')
})

test('CONTROL: a record named in removed_videos is filtered out (the pair fixture is not marked removed)', async () => {
  const project = await pm.createProject({ name: 'Removed Video Filtered' })
  // The same live record, now explicitly marked removed. If the removal filter
  // were inactive the row would still read `processing`/`video-Y`; because it is
  // active, `youtubeRetentionEvidenceFor` drops video-Y and only the failed
  // video-X remains. This proves test 1's live record is genuinely not removed.
  const status = await readEpisodeUploadStatus(
    project.slug, 'EP0001', '',
    {
      records: [{ ...superseded, project_slug: project.slug }, { ...live, project_slug: project.slug }],
      state: {
        episode_video_links: {},
        removed_videos: [{ episode_code: 'EP0001', channel_id: 'channel-1', video_id: 'video-Y' }],
      },
    } as any,
  )
  assert.equal(status.state, 'failed', 'the removed live record no longer decides the state')
  assert.equal(status.video_id, 'video-X', 'with video-Y removed, only the failed video-X record remains')
})
