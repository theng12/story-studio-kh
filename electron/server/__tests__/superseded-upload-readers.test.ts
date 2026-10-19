/**
 * Regression for the oldest-first evidence arrays — 2026-10-19 (follow-up to
 * `episode-upload-superseded-record`).
 *
 * `youtubeRetentionEvidenceFor` (services/youtube-remote-video.ts) builds
 * `accepted_operations` and `ready_operations` in the operation store's index
 * order, which is OLDEST-FIRST — `youtube-operation-store.ts` appends each new
 * `operation_id` to the end of the index. Several readers indexed `[0]` or used
 * `.find()` over those arrays, so an episode with a stale first upload was
 * described by that FIRST record rather than the video it has now:
 *
 *   services/storage-audit.ts:424      `accepted_operations[0]`  -> `youtube_video_id`
 *   services/youtube-remote-video.ts   `ready_operations[0]`     -> `usableYouTubeRemoteEvidence`
 *   services/youtube-remote-video.ts   `.find()` over `ready_operations` (the two proof reads)
 *   services/youtube-remote-video.ts   `.find()` over the records (`remoteVideoFor`)
 *
 * Every one of them now asks `newestNotSuperseded` / `newestReady` from
 * youtube-remote-video.ts, so a superseded or abandoned upload is never the
 * answer a LOOKUP gives. Only the episodes ROW may still name a dead video, and
 * only when that is all the episode has (`newestNotSupersededOrOldest`) — that
 * row exists to say WHY the episode failed.
 *
 * The two on-disk fixtures below are states the app really reaches:
 *
 *  - a first upload YouTube failed and a later accepted replacement (the Domnak
 *    DM0001–DM0003 shape) — `linkYouTubeEpisodeVideo` permits that one
 *    replacement precisely because the old record is superseded;
 *  - an upload that never reached a terminal state (its job was interrupted
 *    before recording one) still sitting `preparing` beside the episode's real
 *    video. Nothing guards against that: `createYouTubeOperation` starts at
 *    `preparing` and accepts a second operation for the same episode.
 *
 * The last block pins the two readers that take `ready_operations` directly. A
 * pair of live `ready` receipts needs a second channel or a re-upload the link
 * guard refuses, so it is asserted at the function boundary rather than staged
 * on disk.
 *
 * EXPECTED RED on the pre-fix source: `video-X` (or an empty id) where
 * `video-Y` is asserted.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

const CHANNEL = 'readers-channel'
const CODE = 'EP0001'
const TITLE = 'Replaced Upload'
const PAYLOAD = { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) }

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let utils: typeof import('../services/utils.js')
let connections: typeof import('../services/youtube-connection-store.js')
let operations: typeof import('../services/youtube-operation-store.js')
let sourceVideo: typeof import('../services/youtube-source-video.js')
let remote: typeof import('../services/youtube-remote-video.js')
let storageAudit: typeof import('../services/storage-audit.js')

before(async () => {
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  utils = await import('../services/utils.js')
  connections = await import('../services/youtube-connection-store.js')
  operations = await import('../services/youtube-operation-store.js')
  sourceVideo = await import('../services/youtube-source-video.js')
  remote = await import('../services/youtube-remote-video.js')
  storageAudit = await import('../services/storage-audit.js')
})

beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})

after(async () => { await tmp?.cleanup() })

/** An accepted episode with a final video, on a project connected to CHANNEL. */
async function connectedEpisode(): Promise<{ slug: string; final: string }> {
  const project = await pm.createProject({ name: 'Superseded Readers' })
  await connections.configureYouTubeApplication({ client_id: 'readers-client', client_secret: 'readers-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Readers Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'readers-access', refresh_token: 'readers-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  const [idea] = await im.addIdeas(project.slug, [{
    title: TITLE, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test')
  await im.acceptIdea(project.slug, idea!.id, false, { override_code: CODE })
  const paths = await utils.resolveEpisodePathsByCode(project.slug, CODE)
  await fs.mkdir(paths.video_dir, { recursive: true })
  const final = path.join(paths.video_dir, `${CODE}_final_video.mp4`)
  await fs.writeFile(final, 'the uploaded bytes')
  // The audit compares the final's mtime against the receipt; an upload is never
  // newer than the file it uploaded.
  const beforeUpload = new Date(Date.now() - 60_000)
  await fs.utimes(final, beforeUpload, beforeUpload)
  return { slug: project.slug, final }
}

/** Open an upload operation for CODE and leave it at `preparing` (never accepted). */
async function openOperation(slug: string): Promise<void> {
  await operations.createYouTubeOperation({
    project_slug: slug, episode_code: CODE, channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: PAYLOAD.source_sha256,
    origin: 'manual', final_action: 'manual_upload',
  })
}

/**
 * One accepted upload for CODE, left in `lifecycle`. Created in call order, so
 * the operation index — and therefore both evidence arrays — is OLDEST-FIRST.
 */
async function uploaded(slug: string, videoId: string, lifecycle: 'accepted' | 'ready' | 'failed'): Promise<void> {
  const opened = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: CODE, channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: PAYLOAD.source_sha256,
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: opened.operation_id, expected_revision: opened.revision,
    channel_id: CHANNEL, video_id: videoId, accepted_at: new Date().toISOString(),
    final_payload: PAYLOAD,
  })
  if (lifecycle !== 'accepted') {
    await operations.updateYouTubeOperation({
      project_slug: slug, operation_id: accepted.operation_id, expected_revision: accepted.revision,
      mutate(record) { record.lifecycle = lifecycle },
    })
  }
}

describe('an episode whose first upload YouTube failed', () => {
  test('the cleanup audit names the replacement, not the superseded upload', async () => {
    const { slug } = await connectedEpisode()
    await uploaded(slug, 'video-X', 'failed')   // YouTube abandoned this one
    await uploaded(slug, 'video-Y', 'accepted') // the replacement the episode has now

    const audit = await storageAudit.auditProjectStorage(slug)
    const row = audit.episodes.find(entry => entry.episode_code === CODE)!
    assert.equal(row.uploaded_to_youtube, true)
    assert.equal(row.youtube_video_id, 'video-Y', 'a failed record is history, not the episode\'s video')

    const found = await remote.remoteVideoFor(slug, CODE, TITLE, CHANNEL)
    assert.equal(found?.video_id, 'video-Y')
  })

  test('CONTROL: with only the failed upload left, the audit still names it', async () => {
    const { slug } = await connectedEpisode()
    await uploaded(slug, 'video-X', 'failed')

    const audit = await storageAudit.auditProjectStorage(slug)
    const row = audit.episodes.find(entry => entry.episode_code === CODE)!
    assert.equal(row.youtube_video_id, 'video-X', 'the audit may still report WHY an episode failed')
  })
})

describe('an episode with an upload that never finished', () => {
  test('the remote-video lookup names the episode\'s actual video, not the abandoned record', async () => {
    const { slug } = await connectedEpisode()
    await openOperation(slug)                   // interrupted before it recorded an outcome
    await uploaded(slug, 'video-Y', 'ready')    // the video the episode actually has

    const found = await remote.remoteVideoFor(slug, CODE, TITLE, CHANNEL)
    assert.equal(found?.video_id, 'video-Y', 'an abandoned operation is not the episode\'s video')
    assert.equal(found?.lifecycle, 'ready')
  })

  test('CONTROL: a superseded record alone is never offered as the episode\'s video', async () => {
    const { slug } = await connectedEpisode()
    await uploaded(slug, 'video-X', 'failed')

    const found = await remote.remoteVideoFor(slug, CODE, TITLE, CHANNEL)
    assert.equal(found, null, 'a lookup must fall through rather than offer a video YouTube killed')
  })
})

describe('readers that take the evidence arrays directly', () => {
  test('usableYouTubeRemoteEvidence answers with the newest ready operation', async () => {
    const ready = (video_id: string, operation_id: string) =>
      ({ operation_id, video_id, source_revision: 'src', channel_id: CHANNEL })
    const evidence = {
      accepted_operations: [],
      ready_operations: [ready('video-X', 'op-old'), ready('video-Y', 'op-new')],
    }
    assert.equal(remote.usableYouTubeRemoteEvidence(evidence).video_id, 'video-Y')
  })

  test('the proof reads match the newest receipt carrying the file\'s bytes', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'readers-')), `${CODE}_final_video.mp4`)
    await fs.writeFile(file, 'the uploaded bytes')
    const revision = await sourceVideo.resolveYouTubeSourceRevision(file)
    // Both receipts carry the SAME bytes — the episode was uploaded twice from
    // one file — so the newest one is the video it has now.
    const receipt = (video_id: string, operation_id: string) =>
      ({ operation_id, video_id, source_revision: revision, channel_id: CHANNEL })
    const evidence = {
      accepted_operations: [],
      ready_operations: [receipt('video-X', 'op-old'), receipt('video-Y', 'op-new')],
    }
    assert.equal((await remote.youtubeArchiveProofForFile(evidence, file)).video_id, 'video-Y')
    assert.equal((await remote.youtubeRetentionProofForFile(evidence, file)).video_id, 'video-Y')
  })
})
