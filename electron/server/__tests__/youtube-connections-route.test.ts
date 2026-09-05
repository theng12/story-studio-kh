import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
// Imported once (module state is bound to STORY_STUDIO_DATA_DIR at import
// time), but every test gets its OWN temp data dir below. Sharing one dir made
// the earlier version of this file order-dependent: a test asserted on rows a
// previous test happened to leave behind, so inserting or reordering a case
// silently broke unrelated assertions and no case could be run alone.
const boot = await useTempDataDir()
const store = await import('../services/youtube-connection-store.js')
const { appSecretsPath, writeAppSecrets } = await import('../services/app-secrets-store.js')
const { encryptToBase64 } = await import('../lib/safe-storage.js')
const { createProject } = await import('../services/project-manager.js')
const { router } = await import('../routes/youtube-connections.js')
const cadence = await import('../services/publish-cadence.js')
const plans = await import('../services/upload-plans.js')
const { registryCredentialFor } = await import('../lib/youtube-client.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function isolate(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return temp.dir
}

/** A fresh install with the owner application already saved. */
async function withApplication(): Promise<void> {
  await isolate()
  await store.configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
}

const CLIENT_ID = 'youtube-route-client-id'
const CLIENT_SECRET = 'youtube-route-client-secret-value'
const REPLACEMENT_SECRET = 'youtube-route-replacement-secret-value'

async function connectChannel(channelId: string, title = channelId): Promise<void> {
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: channelId, title, granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: `route-access-${channelId}`,
      refresh_token: `route-refresh-${channelId}`,
      expires_at: Date.now() + 3_600_000,
    },
  })
}

test('an unconfigured install reports no application, no channels, and no secret field', async () => {
  await isolate()
  const res = await request(app).get('/api/youtube/connections')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { application: null, channels: [], assignments: [] })
  assert.equal(JSON.stringify(res.body).includes('client_secret'), false)
})

test('surfaces and performs only the explicit recoverable YouTube credential reset', async () => {
  await isolate()
  const provider = { apiKey: 'gsk_route_recovery', userSet: true, generation: 'route-generation' }
  await fs.writeFile(appSecretsPath(), JSON.stringify({
    __encrypted: true,
    version: 1,
    ciphertext: encryptToBase64(JSON.stringify({
      schema_version: 3,
      providers: { genstudio: provider },
      youtube: { oauth_client: { application_id: 'broken-without-secret' } },
    })),
  }))

  const listed = await request(app).get('/api/youtube/connections')
  assert.equal(listed.status, 409)
  assert.equal(listed.body.code, 'YOUTUBE_SECRET_RECOVERY_REQUIRED')
  assert.equal(JSON.stringify(listed.body).includes('gsk_route_recovery'), false)

  const recovered = await request(app).delete('/api/youtube/connections/credential-authority')
  assert.equal(recovered.status, 204)
  const after = await request(app).get('/api/youtube/connections')
  assert.equal(after.status, 200)
  assert.deepEqual(after.body, { application: null, channels: [], assignments: [] })
  const secrets = await (await import('../services/app-secrets-store.js')).readAppSecrets()
  assert.deepEqual(secrets.providers.genstudio, provider)
})

test('starting a connect without an application is refused with a stable code', async () => {
  await isolate()
  const res = await request(app).post('/api/youtube/connections/channels/connect').send({})
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_APPLICATION_NOT_CONFIGURED')
  assert.equal(typeof res.body.detail, 'string')
  assert.equal('stack' in res.body, false)
})

test('saving the owner application reports it without ever returning the secret', async () => {
  await isolate()
  const res = await request(app)
    .put('/api/youtube/connections/application')
    .send({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, google_cloud_project_id: 'cloud-project-1' })

  assert.equal(res.status, 200)
  assert.equal(res.body.application.client_id, CLIENT_ID)
  assert.equal(res.body.application.google_cloud_project_id, 'cloud-project-1')
  assert.equal(typeof res.body.application.fingerprint, 'string')
  assert.equal(res.body.application.has_client_secret, true)
  assert.equal('client_secret' in res.body.application, false)
  assert.equal(JSON.stringify(res.body).includes(CLIENT_SECRET), false)

  const listed = await request(app).get('/api/youtube/connections')
  assert.equal(listed.body.application.has_client_secret, true)
  assert.equal(JSON.stringify(listed.body).includes(CLIENT_SECRET), false)
})

test('reports a public application with a missing encrypted secret as reconnect-required setup', async () => {
  await withApplication()
  await connectChannel('route-channel-missing-secret')
  await fs.rm(appSecretsPath(), { force: true })
  const res = await request(app).get('/api/youtube/connections')
  assert.equal(res.status, 200)
  assert.equal(res.body.application.client_id, CLIENT_ID)
  assert.equal(res.body.application.has_client_secret, false)
  assert.equal(res.body.channels[0].status, 'reconnect_required')
})

test('rejects an application without both credentials', async () => {
  await isolate()
  const res = await request(app)
    .put('/api/youtube/connections/application')
    .send({ client_id: CLIENT_ID })
  assert.equal(res.status, 400)
  assert.equal(typeof res.body.detail, 'string')
})

test('lists connected channels with health and never a token', async () => {
  await withApplication()
  await connectChannel('route-channel-a', 'Channel A')
  await connectChannel('route-channel-b', 'Channel B')

  const res = await request(app).get('/api/youtube/connections')
  assert.equal(res.status, 200)
  const ids = res.body.channels.map((channel: { channel_id: string }) => channel.channel_id).sort()
  assert.deepEqual(ids, ['route-channel-a', 'route-channel-b'])
  const first = res.body.channels.find((channel: { channel_id: string }) => channel.channel_id === 'route-channel-a')
  assert.equal(first.title, 'Channel A')
  assert.equal(first.status, 'connected')
  assert.equal(typeof first.last_refresh_at, 'string')
  assert.equal(first.assigned_project_slug, null)

  const payload = JSON.stringify(res.body)
  for (const secret of ['route-access-route-channel-a', 'route-refresh-route-channel-a', CLIENT_SECRET]) {
    assert.equal(payload.includes(secret), false, `${secret} must not reach the connections route`)
  }
})

test('projects a channel as reconnect-required when its token is missing or belongs to another app', async () => {
  await withApplication()
  await connectChannel('route-channel-missing-token', 'Missing token')
  await connectChannel('route-channel-wrong-token-app', 'Wrong token app')
  await writeAppSecrets(v3 => {
    delete v3.youtube!.channel_tokens!['route-channel-missing-token']
    v3.youtube!.channel_tokens!['route-channel-wrong-token-app']!.application_id = 'youtube_app_wrong'
  })

  const res = await request(app).get('/api/youtube/connections')
  assert.equal(res.status, 200)
  assert.equal(res.body.application.has_client_secret, true)
  assert.equal(res.body.channels.find((row: any) => row.channel_id === 'route-channel-missing-token').status, 'reconnect_required')
  assert.equal(res.body.channels.find((row: any) => row.channel_id === 'route-channel-wrong-token-app').status, 'reconnect_required')
  assert.equal(JSON.stringify(res.body).includes('route-access-'), false)
  assert.equal(JSON.stringify(res.body).includes('route-refresh-'), false)
})

test('assigns exactly one channel to a project and reports the owner on the channel', async () => {
  await withApplication()
  await connectChannel('route-channel-a', 'Channel A')
  const project = await createProject({ name: 'Route Assignment' })

  const empty = await request(app).get(`/api/projects/${project.slug}/youtube/assignment`)
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { assignment: null })

  const assigned = await request(app)
    .put(`/api/projects/${project.slug}/youtube/assignment`)
    .send({ channel_id: 'route-channel-a', expected_previous_channel_id: null })
  assert.equal(assigned.status, 200)
  assert.equal(assigned.body.assignment.channel_id, 'route-channel-a')

  const listed = await request(app).get('/api/youtube/connections')
  const owned = listed.body.channels.find((channel: { channel_id: string }) => channel.channel_id === 'route-channel-a')
  assert.equal(owned.assigned_project_slug, project.slug)
  assert.deepEqual(listed.body.assignments.map((row: { project_slug: string }) => row.project_slug), [project.slug])
})

test('refuses a channel another project already owns', async () => {
  await withApplication()
  await connectChannel('route-channel-a', 'Channel A')
  const owner = await createProject({ name: 'Route Owner Project' })
  await request(app)
    .put(`/api/projects/${owner.slug}/youtube/assignment`)
    .send({ channel_id: 'route-channel-a', expected_previous_channel_id: null })

  const other = await createProject({ name: 'Route Second Project' })
  const res = await request(app)
    .put(`/api/projects/${other.slug}/youtube/assignment`)
    .send({ channel_id: 'route-channel-a', expected_previous_channel_id: null })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_CHANNEL_ALREADY_ASSIGNED')
})

test('refuses a replacement whose expected previous channel is stale', async () => {
  await withApplication()
  await connectChannel('route-channel-b', 'Channel B')
  const project = await createProject({ name: 'Route Stale Replacement' })
  await request(app)
    .put(`/api/projects/${project.slug}/youtube/assignment`)
    .send({ channel_id: 'route-channel-b', expected_previous_channel_id: null })

  const stale = await request(app)
    .put(`/api/projects/${project.slug}/youtube/assignment`)
    .send({ channel_id: 'route-channel-b', expected_previous_channel_id: 'route-channel-gone' })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'YOUTUBE_ASSIGNMENT_CHANGED')
})

test('replacing the owner application marks every channel reconnect required', async () => {
  await withApplication()
  await connectChannel('route-channel-a', 'Channel A')
  await connectChannel('route-channel-b', 'Channel B')
  const res = await request(app)
    .put('/api/youtube/connections/application')
    .send({ client_id: 'youtube-route-replacement-client', client_secret: REPLACEMENT_SECRET })
  assert.equal(res.status, 200)
  assert.equal(res.body.dependent_channel_count, 2)

  const listed = await request(app).get('/api/youtube/connections')
  for (const channel of listed.body.channels) {
    assert.equal(channel.status, 'reconnect_required', channel.channel_id)
  }
  assert.equal(JSON.stringify(listed.body).includes(REPLACEMENT_SECRET), false)
})

test('disconnecting a channel releases its assignment and reports an unknown channel honestly', async () => {
  await withApplication()
  await connectChannel('route-channel-a', 'Channel A')
  const project = await createProject({ name: 'Route Disconnect' })
  await request(app)
    .put(`/api/projects/${project.slug}/youtube/assignment`)
    .send({ channel_id: 'route-channel-a', expected_previous_channel_id: null })

  const before = await request(app).get('/api/youtube/connections')
  const assignedProject = before.body.assignments
    .find((row: { channel_id: string }) => row.channel_id === 'route-channel-a')?.project_slug
  assert.equal(typeof assignedProject, 'string')

  const removed = await request(app).delete('/api/youtube/connections/channels/route-channel-a')
  assert.equal(removed.status, 204)

  const after = await request(app).get('/api/youtube/connections')
  assert.equal(after.body.channels.some((channel: { channel_id: string }) => channel.channel_id === 'route-channel-a'), false)
  assert.equal(after.body.assignments.some((row: { project_slug: string }) => row.project_slug === assignedProject), false)

  const missing = await request(app).delete('/api/youtube/connections/channels/route-channel-a')
  assert.equal(missing.status, 409)
  assert.equal(missing.body.code, 'YOUTUBE_CHANNEL_NOT_CONNECTED')
})

test('releasing an assignment requires the caller to name the channel it expects', async () => {
  await withApplication()
  const project = await createProject({ name: 'Route Release' })
  await connectChannel('route-channel-release')
  await request(app)
    .put(`/api/projects/${project.slug}/youtube/assignment`)
    .send({ channel_id: 'route-channel-release', expected_previous_channel_id: null })

  const stale = await request(app)
    .delete(`/api/projects/${project.slug}/youtube/assignment`)
    .send({ expected_channel_id: 'route-channel-gone' })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'YOUTUBE_ASSIGNMENT_CHANGED')

  const released = await request(app)
    .delete(`/api/projects/${project.slug}/youtube/assignment`)
    .send({ expected_channel_id: 'route-channel-release' })
  assert.equal(released.status, 204)
  assert.equal((await store.getProjectYouTubeAssignment(project.slug)), null)
})

test('an unknown connect flow is reported, not thrown', async () => {
  await isolate()
  const res = await request(app).get('/api/youtube/connections/channels/connect/flow-that-never-existed')
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'unknown')
  assert.equal(res.body.error_code, 'YOUTUBE_OAUTH_FLOW_UNKNOWN')
})

test('a failure that is not one of ours still comes back humanized, coded, and at its own status', async () => {
  // A corrupt project.json is a real, non-YouTube failure that reaches these
  // routes through getProject(). It carries the repo-wide `expose: true`
  // marker, and passing such a message through raw would skip this app's
  // redaction and drop the stable `code` the plan promises on every failure.
  const dir = await isolate()
  const project = await createProject({ name: 'Route Corrupt Project' })
  await fs.writeFile(path.join(dir, 'projects', project.slug, 'project.json'), '{"slug": ')

  for (const send of [
    () => request(app).get(`/api/projects/${project.slug}/youtube/assignment`),
    () => request(app).put(`/api/projects/${project.slug}/youtube/assignment`)
      .send({ channel_id: 'route-channel-a', expected_previous_channel_id: null }),
    () => request(app).delete(`/api/projects/${project.slug}/youtube/assignment`)
      .send({ expected_channel_id: 'route-channel-a' }),
  ]) {
    const res = await send()
    assert.notEqual(res.status, 200)
    assert.notEqual(res.status, 500, 'the error states its own status rather than collapsing to 500')
    assert.equal(typeof res.body.code, 'string', 'every failure body carries a stable code')
    assert.equal(typeof res.body.detail, 'string')
    assert.equal('stack' in res.body, false)
  }
})

// ── Cadence -> plan ───────────────────────────────────────────────────────
//
// Settings tells the owner "this becomes the channel's upload plan the moment
// you connect a YouTube account". The only caller of `ensurePlanForAccount` was
// `/upload/oauth/start`, deleted in the cutover, so for the whole of v1.5.0's
// development that sentence promised something nothing performed. It was fixed
// by calling it from the assignment route - and then recorded as "covered by
// automated tests" when no test named it. These are that coverage.

test('assigning a channel turns the project cadence into a real upload plan', async () => {
  await withApplication()
  await createProject({ name: 'Cadence Seed' })
  await connectChannel('UC-cadence')
  await cadence.writeCadence('cadence-seed', {
    schedule: { weekdays: [1, 4], time_local: '18:00', timezone: 'Asia/Phnom_Penh', interval_weeks: 1 },
    defaults: { privacy_status: 'private', made_for_kids: false },
  })

  const res = await request(app)
    .put('/api/projects/cadence-seed/youtube/assignment')
    .send({ channel_id: 'UC-cadence' })
  assert.equal(res.status, 200)

  // The response says a plan was seeded, AND the plan is really there under the
  // registry credential the uploads will use. Asserting only the response would
  // pass on a route that reported a seeding it never performed.
  assert.ok(res.body.seeded_plan_id, 'the route reports the plan it created')
  const active = await plans.getActivePlanId('cadence-seed', 'youtube', registryCredentialFor('UC-cadence'))
  assert.equal(active, res.body.seeded_plan_id, 'and that plan is the active one')

  const plan = (await plans.listPlans('cadence-seed')).find(entry => entry.id === active)
  assert.ok(plan, 'the plan exists')
  assert.deepEqual(plan!.schedule.weekdays, [1, 4], 'it carries the cadence the owner set')
  assert.equal(plan!.schedule.time_local, '18:00')
})

test('a project with no cadence gets no invented plan', async () => {
  await withApplication()
  await createProject({ name: 'No Cadence' })
  await connectChannel('UC-nocadence')

  const res = await request(app)
    .put('/api/projects/no-cadence/youtube/assignment')
    .send({ channel_id: 'UC-nocadence' })
  assert.equal(res.status, 200)
  assert.equal(res.body.seeded_plan_id, undefined, 'nothing to seed from, so nothing seeded')
  assert.equal(await plans.getActivePlanId('no-cadence', 'youtube', registryCredentialFor('UC-nocadence')), '', 'no plan was made active')
})

test('re-assigning the same channel never overwrites the plan already there', async () => {
  await withApplication()
  await createProject({ name: 'Reassign' })
  await connectChannel('UC-reassign')
  await cadence.writeCadence('reassign', {
    schedule: { weekdays: [2], time_local: '09:00', timezone: 'Asia/Phnom_Penh', interval_weeks: 1 },
    defaults: { privacy_status: 'private', made_for_kids: false },
  })

  const first = await request(app)
    .put('/api/projects/reassign/youtube/assignment').send({ channel_id: 'UC-reassign' })
  assert.ok(first.body.seeded_plan_id)

  // The owner edits the cadence afterwards. A second assignment must NOT
  // rewrite the plan from it — the plan is his now.
  await cadence.writeCadence('reassign', {
    schedule: { weekdays: [5], time_local: '20:00', timezone: 'Asia/Phnom_Penh', interval_weeks: 1 },
    defaults: { privacy_status: 'private', made_for_kids: false },
  })
  const second = await request(app)
    .put('/api/projects/reassign/youtube/assignment')
    .send({ channel_id: 'UC-reassign', expected_previous_channel_id: 'UC-reassign' })
  assert.equal(second.status, 200)
  assert.equal(second.body.seeded_plan_id, undefined, 'no second seeding')

  const active = await plans.getActivePlanId('reassign', 'youtube', registryCredentialFor('UC-reassign'))
  assert.equal(active, first.body.seeded_plan_id, 'still the first plan')
  const plan = (await plans.listPlans('reassign')).find(entry => entry.id === active)
  assert.deepEqual(plan!.schedule.weekdays, [2], 'and it kept its original schedule')
})
