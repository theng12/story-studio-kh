/**
 * The planned date one episode's row shows must come from the NEWEST thing
 * YouTube said, not from the operation's `remote_snapshot` alone: a ready
 * video's snapshot is not refreshed while the shared publication cache is, so a
 * snapshot-only read showed "published" and "Plan: <old date>" at once.
 *
 * These pin the map (`readItemSchedule`) and the Publish row together: a newer
 * public answer clears the plan; a newer private schedule wins, and a private
 * answer with no publishAt keeps a populated sidecar; an older cache cannot
 * override a newer operation; an obsolete or removed receipt is ignored; a
 * sidecar-only legacy video resolves its cache row; and an explicit "no
 * schedule" answer suppresses a stale legacy `upload_item_schedule` entry.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

const boot = await useTempDataDir()
const connections = await import('../services/youtube-connection-store.js')
const operations = await import('../services/youtube-operation-store.js')
const pm = await import('../services/project-manager.js')
const utils = await import('../services/utils.js')
const im = await import('../services/idea-manager.js')
const uploadPlans = await import('../services/upload-plans.js')
const publishing = await import('../services/youtube-project-publishing-store.js')
const uploadSidecar = await import('../services/upload-sidecar.js')
const { recordYouTubePublicationObservations } = await import('../services/youtube-publication-cache.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const CHANNEL = 'UC-newest-observation'
const TITLE = 'A Quiet Coast at Dusk'
const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function projectWithChannel(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const created = await pm.createProject({ name: 'Newest Observation' })
  await connections.configureYouTubeApplication({ client_id: 'newest-client', client_secret: 'newest-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Newest Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  return created.slug
}

async function acceptedEpisode(slug: string): Promise<string> {
  const title = TITLE
  const [idea] = await im.addIdeas(slug, [{
    title, logline: 'Tide pools settle.', themes: ['calm'], suggested_chapters: 3, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const accepted = await im.acceptIdea(slug, idea!.id)
  const code = accepted.idea.episode_code!
  const paths = await utils.resolveEpisodePaths(slug, code, title)
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({ title, description: 'Tide pools settle.', tags: ['x'] }))
  return code
}

/** An accepted operation with a video id and the given confirmed remote snapshot. */
async function acceptedOperation(
  slug: string, code: string, videoId: string,
  snapshot: { fetched_at: string; privacy_status: string; scheduled_for: string | null },
): Promise<void> {
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: code, channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta', origin: 'manual', final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: videoId, accepted_at: snapshot.fetched_at,
    final_payload: {
      snippet_json: JSON.stringify({ title: `Local ${code}`, description: 'Local', tags: [], categoryId: '24' }),
      status_json: JSON.stringify({ privacyStatus: snapshot.privacy_status }),
      source_sha256: 'a'.repeat(64),
    },
  })
  const accepted = await operations.readYouTubeOperation(slug, made.operation_id)
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: accepted!.revision,
    mutate(record) {
      record.remote_snapshot = {
        fetched_at: snapshot.fetched_at, title: `Local ${code}`, description: '', tags: [],
        privacy_status: snapshot.privacy_status, scheduled_for: snapshot.scheduled_for,
      }
    },
  })
}

async function cacheObservation(
  slug: string, code: string, videoId: string,
  observation: { checked_at: string; privacy_status: string; scheduled_for: string | null },
): Promise<void> {
  await recordYouTubePublicationObservations({
    project_slug: slug, channel_id: CHANNEL,
    checks: [{
      video_id: videoId, source: 'operation', episode_code: code, checked_at: observation.checked_at,
      upload_status: 'processed', privacy_status: observation.privacy_status, scheduled_for: observation.scheduled_for,
    }],
  })
}

const PLANNED = '2026-10-19T14:00:00.000Z'
const OLDER = '2026-10-18T00:00:00.000Z'
const NEWER = '2026-10-20T14:26:55.821Z'

/** A legacy YouTube sidecar — the only local record of an episode's video. */
async function writeYouTubeSidecar(
  slug: string, code: string,
  fields: { video_id: string; scheduled_for: string | null; privacy_status: 'private' | 'public' | 'unlisted' },
): Promise<void> {
  await uploadSidecar.writeSidecar(slug, code, TITLE, {
    platform: 'youtube', video_id: fields.video_id, account_id: 'acct-local',
    channel_id: CHANNEL, uploaded_at: OLDER, last_sync_at: OLDER,
    scheduled_for: fields.scheduled_for, privacy_status: fields.privacy_status,
    title: TITLE, description: '', tags: [], thumbnail_set: false,
  })
}

/** A verified receipt for a video linked to the episode (Reconcile / verified link). */
async function linkReceipt(
  slug: string, code: string, videoId: string,
  receipt: { verified_at: string; privacy_status: string; scheduled_for: string | null },
): Promise<void> {
  await publishing.linkYouTubeEpisodeVideo({
    project_slug: slug, episode_code: code, channel_id: CHANNEL, video_id: videoId,
    source: 'reconcile', decided_at: receipt.verified_at,
  })
  await publishing.recordYouTubeEpisodePublication({
    project_slug: slug, episode_code: code, channel_id: CHANNEL, video_id: videoId,
    verified_at: receipt.verified_at, privacy_status: receipt.privacy_status, scheduled_for: receipt.scheduled_for,
  })
}

/**
 * A receipt lingering on a DIFFERENT video than the episode's current operation — the historical
 * inconsistent state a lost, imported or rolled-back link leaves behind. `linkYouTubeEpisodeVideo`
 * refuses a second link on purpose (the video identity is immutable), so the fixture writes the
 * state file the way real history would and leaves that product guard untouched.
 */
async function seedObsoleteReceipt(
  slug: string, code: string, videoId: string,
  receipt: { verified_at: string; privacy_status: string; scheduled_for: string | null },
): Promise<void> {
  const statePath = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json',
  )
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
  state.episode_video_links[code] = {
    channel_id: CHANNEL, video_id: videoId, linked_at: receipt.verified_at, source: 'reconcile',
    publication: {
      verified_at: receipt.verified_at, privacy_status: receipt.privacy_status,
      scheduled_for: receipt.scheduled_for,
    },
  }
  await fs.writeFile(statePath, JSON.stringify(state))
}

async function row(slug: string, code: string): Promise<any> {
  const res = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.episodes.find((episode: any) => episode.episode_code === code)
}

test('a newer public observation clears a stale planned date, on the map and the row', async () => {
  const slug = await projectWithChannel()
  const code = await acceptedEpisode(slug)
  // The operation still says private + a publishAt (its last per-operation check).
  await acceptedOperation(slug, code, 'vid-newest', { fetched_at: OLDER, privacy_status: 'private', scheduled_for: PLANNED })
  // The publication cache saw the video public afterwards.
  await cacheObservation(slug, code, 'vid-newest', { checked_at: NEWER, privacy_status: 'public', scheduled_for: null })

  assert.equal((await uploadPlans.readItemSchedule(slug))[code], undefined,
    'a published episode is not a planned date')

  const published = await row(slug, code)
  assert.equal(published.publication.state, 'published')
  assert.equal(published.plan.scheduled_at, undefined, 'the row does not show a plan for a published episode')
})

test('a newer private schedule wins over an older operation date', async () => {
  const slug = await projectWithChannel()
  const code = await acceptedEpisode(slug)
  const oldDate = '2026-10-13T14:00:00.000Z'
  await acceptedOperation(slug, code, 'vid-private', { fetched_at: OLDER, privacy_status: 'private', scheduled_for: oldDate })
  await cacheObservation(slug, code, 'vid-private', { checked_at: NEWER, privacy_status: 'private', scheduled_for: PLANNED })

  assert.equal((await uploadPlans.readItemSchedule(slug))[code], PLANNED, 'the newest answer wins')
  assert.equal((await row(slug, code)).plan.scheduled_at, PLANNED)
})

test('an older cache observation cannot override a newer operation snapshot', async () => {
  const slug = await projectWithChannel()
  const code = await acceptedEpisode(slug)
  const newDate = '2026-10-27T14:00:00.000Z'
  const oldDate = '2026-10-13T14:00:00.000Z'
  await acceptedOperation(slug, code, 'vid-both', { fetched_at: NEWER, privacy_status: 'private', scheduled_for: newDate })
  await cacheObservation(slug, code, 'vid-both', { checked_at: OLDER, privacy_status: 'private', scheduled_for: oldDate })

  assert.equal((await uploadPlans.readItemSchedule(slug))[code], newDate,
    'the newest answer wins, whichever store it came from')
  assert.equal((await row(slug, code)).plan.scheduled_at, newDate,
    'the row shows the same newest answer as the map')
})

test('a newer cached private+null answer keeps a populated local sidecar plan', async () => {
  const slug = await projectWithChannel()
  const code = await acceptedEpisode(slug)
  // The only local record is a legacy sidecar carrying the plan.
  await writeYouTubeSidecar(slug, code, { video_id: 'vid-sidecar', scheduled_for: PLANNED, privacy_status: 'private' })
  // YouTube answered private with no publishAt afterwards.
  await cacheObservation(slug, code, 'vid-sidecar', { checked_at: NEWER, privacy_status: 'private', scheduled_for: null })

  assert.equal((await uploadPlans.readItemSchedule(slug))[code], PLANNED,
    'a private answer with no publishAt is not a competing claim — the local plan stands')
  assert.equal((await row(slug, code)).plan.scheduled_at, PLANNED)
})

test('a newer public answer for a sidecar-only legacy video clears its plan', async () => {
  const slug = await projectWithChannel()
  const code = await acceptedEpisode(slug)
  // No operation and no link: the sidecar is the only thing naming the video.
  await writeYouTubeSidecar(slug, code, { video_id: 'vid-legacy-only', scheduled_for: PLANNED, privacy_status: 'private' })
  await cacheObservation(slug, code, 'vid-legacy-only', { checked_at: NEWER, privacy_status: 'public', scheduled_for: null })

  assert.equal((await uploadPlans.readItemSchedule(slug))[code], undefined,
    'the sidecar names the video, so the cache observation for it is read')
  assert.equal((await row(slug, code)).plan.scheduled_at, undefined)
})

test('a newer receipt for an obsolete video does not override the current operation', async () => {
  const slug = await projectWithChannel()
  const code = await acceptedEpisode(slug)
  // The operation names THIS episode's current video, checked earlier.
  await acceptedOperation(slug, code, 'vid-current', { fetched_at: OLDER, privacy_status: 'private', scheduled_for: PLANNED })
  // A receipt lingers on a DIFFERENT (obsolete) video with a newer public answer.
  await seedObsoleteReceipt(slug, code, 'vid-obsolete', { verified_at: NEWER, privacy_status: 'public', scheduled_for: null })

  assert.equal((await uploadPlans.readItemSchedule(slug))[code], PLANNED,
    'the current video wins; a newer receipt for a different video is not this episode')
  assert.equal((await row(slug, code)).plan.scheduled_at, PLANNED)
})

test('a receipt for a removed video is excluded', async () => {
  const slug = await projectWithChannel()
  const code = await acceptedEpisode(slug)
  // The sidecar names a healthy video; the receipt points at a video YouTube removed.
  await writeYouTubeSidecar(slug, code, { video_id: 'vid-sidecar-healthy', scheduled_for: PLANNED, privacy_status: 'private' })
  await linkReceipt(slug, code, 'vid-removed', { verified_at: NEWER, privacy_status: 'public', scheduled_for: null })
  await publishing.recordYouTubeVideoRemoval({
    project_slug: slug, episode_code: code, channel_id: CHANNEL, video_id: 'vid-removed',
  })

  assert.equal((await uploadPlans.readItemSchedule(slug))[code], PLANNED,
    'a removed video\'s public receipt must not clear the live local plan')
  assert.equal((await row(slug, code)).plan.scheduled_at, PLANNED)
})

test('an explicit no-schedule answer suppresses a stale legacy episode date', async () => {
  const slug = await projectWithChannel()
  const code = await acceptedEpisode(slug)
  // YouTube answered public with no publishAt; the pre-migration legacy map
  // still carries an old date for the same episode code.
  await acceptedOperation(slug, code, 'vid-legacy', { fetched_at: NEWER, privacy_status: 'public', scheduled_for: null })
  await pm.updateConfig(slug, {
    [uploadPlans.LEGACY_SCHEDULE_FIELD]: { [code]: PLANNED, 'import:example': PLANNED },
  } as any)

  const schedule = await uploadPlans.readItemSchedule(slug)
  assert.equal(schedule[code], undefined, 'the legacy date must not resurrect a published episode')
  assert.equal(schedule['import:example'], PLANNED, 'non-episode legacy keys still ride through')
})

test('an empty publishAt answer is no schedule either, and clears the legacy date', async () => {
  const slug = await projectWithChannel()
  const code = await acceptedEpisode(slug)
  // A legacy operation whose stored status carries an EMPTY publishAt and no
  // confirmed snapshot: `''` is not a date, and it is not the absent field a
  // stale `upload_item_schedule` entry is allowed to fill. Without the
  // normalization the answer fell through to the legacy map.
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: code, channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta', origin: 'manual', final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: 'vid-empty-publish-at', accepted_at: NEWER,
    final_payload: {
      snippet_json: JSON.stringify({ title: `Local ${code}`, description: 'Local', tags: [], categoryId: '24' }),
      status_json: JSON.stringify({ privacyStatus: 'public', publishAt: '' }),
      source_sha256: 'a'.repeat(64),
    },
  })
  await pm.updateConfig(slug, {
    [uploadPlans.LEGACY_SCHEDULE_FIELD]: { [code]: PLANNED },
  } as any)

  // The state says WHICH zero it is: an explicit "no schedule", never `''`.
  assert.equal((await uploadPlans.readItemPublicationStates(slug))[code]?.scheduled_for, null)
  assert.equal((await uploadPlans.readItemSchedule(slug))[code], undefined,
    'an empty publishAt must not let the legacy date resurrect')
})
