/**
 * The global Publishing Overview route.
 *
 * It must be a read: no body, no provider call, and a shape the page can trust.
 * The plan-less channel case is asserted here too, because the route is where
 * an empty answer has to keep meaning exactly one thing.
 *
 * NOTE: written but UNRUN — adda owns the execution lease.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { afterEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

const boot = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const im = await import('../services/idea-manager.js')
const connections = await import('../services/youtube-connection-store.js')
const store = await import('../services/youtube-project-publishing-store.js')
const { router } = await import('../routes/publishing-overview.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

let tmp: { dir: string; cleanup: () => Promise<void> } | undefined
afterEach(async () => { await tmp?.cleanup(); tmp = undefined })

const CHANNEL = 'UC-pub-route'

/** A channel that is ASSIGNED and CONNECTED, so the confirmed half is reachable. */
async function connectedProject(name: string, prefix: string) {
  const created = await pm.createProject({ name, episode_prefix: prefix })
  await connections.configureYouTubeApplication({ client_id: 'po-route-client', client_secret: 'po-route-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Route Publishing Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'po-route-access', refresh_token: 'po-route-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  return created
}

/** An accepted episode with a finished, admissible final video. */
async function acceptedEpisode(slug: string, code: string, title: string): Promise<void> {
  const [idea] = await im.addIdeas(slug, [{
    title, logline: 'l', themes: ['t'], suggested_chapters: 3, suggested_length: '10 min', mood: 'm',
  }], 'test-model')
  await im.promoteToAccepted(slug, idea!.id, { episode_code: code })
  const paths = await (await import('../services/utils.js')).resolveEpisodePaths(slug, code, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(`${paths.video_dir}/${code}_final_video.mp4`, Buffer.alloc(2048, 1))
}

test('GET /api/publishing/overview reports every channel and a plan-less channel honestly', async () => {
  tmp = await useTempDataDir()
  await pm.createProject({ name: 'Route Channel', episode_prefix: 'RP' })

  const res = await request(app).get('/api/publishing/overview')

  assert.equal(res.status, 200)
  assert.equal(typeof res.body.generated_at, 'string')
  assert.equal(typeof res.body.cache_ttl_ms, 'number')
  assert.ok(Array.isArray(res.body.channels))
  assert.ok(Array.isArray(res.body.calendar))
  assert.equal(res.body.channels.length, 1)

  const channel = res.body.channels[0]
  assert.equal(channel.slug, 'route-channel')
  assert.equal(channel.plan_set, false)
  assert.equal(channel.confirmed.freshness, 'unknown')
  assert.equal(channel.confirmed.error, 'no_channel_assigned')
  assert.equal(channel.coverage.at_risk, false)
  assert.match(channel.next_action.url, /^\/projects\/route-channel\//)
})

test('an unreadable plan is reported as unreadable, and does not fail the whole route', async () => {
  tmp = await useTempDataDir()
  const created = await pm.createProject({ name: 'Route Corrupt', episode_prefix: 'RC' })
  await fs.writeFile(`${pm.projectsRoot()}/${created.slug}/config.json`, '{ not json')

  const res = await request(app).get('/api/publishing/overview')

  // One channel's broken plan must not turn the fleet view into a 500.
  assert.equal(res.status, 200)
  const channel = res.body.channels[0]
  assert.equal(channel.plan_set, null)
  assert.equal(typeof channel.plan_error, 'string')
})

test('a corrupt idea store reaches the client as unknown, never a confident 0', async () => {
  tmp = await useTempDataDir()
  const created = await pm.createProject({ name: 'Route Ideas', episode_prefix: 'RI' })

  // Readable and genuinely empty: a real 0 travels as a 0.
  let res = await request(app).get('/api/publishing/overview')
  assert.equal(res.status, 200)
  assert.equal(res.body.channels[0].readiness.episodes, 0)
  assert.equal(res.body.channels[0].readiness.ready_to_publish, 0)
  assert.equal(res.body.channels[0].readiness.error, undefined)

  // Unparseable: unknown, with a reason — and still a 200, not a 500.
  await fs.writeFile(`${pm.projectsRoot()}/${created.slug}/ideas.json`, '{ not json')
  res = await request(app).get('/api/publishing/overview')
  assert.equal(res.status, 200)
  const channel = res.body.channels[0]
  // null, not a missing field: a dropped key would serialize the same as
  // "no answer" and the page would render a blank, which is the defect.
  assert.equal(channel.readiness.episodes, null)
  assert.equal(channel.readiness.episodes_with_code, null)
  assert.equal(channel.readiness.ready_to_publish, null)
  assert.equal(channel.readiness.in_progress, null)
  assert.equal(channel.coverage.ready_video_count, null)
  assert.equal(typeof channel.readiness.error, 'string')
  assert.deepEqual(channel.recommendations, [])
})

test('a failed YouTube link read is unknown through the route, with no publish recommendation', async () => {
  tmp = await useTempDataDir()
  const created = await connectedProject('Route Links', 'RL')
  await acceptedEpisode(created.slug, 'RL0001', 'Already On YouTube')
  await acceptedEpisode(created.slug, 'RL0002', 'Finished Locally')
  await store.linkYouTubeEpisodeVideo({
    project_slug: created.slug, episode_code: 'RL0001', channel_id: CHANNEL,
    video_id: 'vid-route-linked', source: 'upload', decided_at: new Date().toISOString(),
  })

  // Baseline: the linked episode is not offered; the finished unlinked one is.
  let res = await request(app).get('/api/publishing/overview')
  assert.equal(res.status, 200)
  assert.equal(res.body.channels[0].readiness.on_youtube, 1)
  assert.equal(res.body.channels[0].readiness.ready_to_publish, 1)
  assert.deepEqual(res.body.channels[0].recommendations.map((r: any) => r.episode_code), ['RL0002'])

  // The link read now fails: neither the count nor the publish claim can stand.
  await fs.writeFile(`${pm.projectsRoot()}/${created.slug}/youtube/project-state.json`, '{ not json')
  res = await request(app).get('/api/publishing/overview')
  assert.equal(res.status, 200)
  const channel = res.body.channels[0]
  assert.equal(channel.readiness.on_youtube, null)
  assert.equal(channel.readiness.ready_to_publish, null)
  assert.equal(channel.coverage.ready_video_count, null)
  assert.equal(typeof channel.readiness.error, 'string')
  assert.deepEqual(channel.recommendations, [])
  assert.equal(JSON.stringify(channel.recommendations).includes('not on YouTube yet'), false)
})
