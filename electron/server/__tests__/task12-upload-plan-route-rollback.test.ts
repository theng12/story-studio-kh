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
const projects = await import('../services/project-manager.js')
const ideas = await import('../services/idea-manager.js')
const plans = await import('../services/upload-plans.js')
const utils = await import('../services/utils.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

const CHANNEL = 'UC-task12-plan'
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function scenario(): Promise<{
  slug: string
  planId: string
  episodes: Array<{ code: string; title: string; sidecar: string }>
}> {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const project = await projects.createProject({ name: 'Task 12 route rollback' })
  await connections.configureYouTubeApplication({
    client_id: 'task12-plan-client', client_secret: 'task12-plan-client-secret',
  })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Task 12 Plan Channel', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'task12-plan-access', refresh_token: 'task12-plan-refresh',
      expires_at: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/youtube.upload',
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })

  const accepted: Array<{ code: string; title: string; sidecar: string }> = []
  for (const title of ['First planned episode', 'Second planned episode']) {
    const [idea] = await ideas.addIdeas(project.slug, [{
      title, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '',
    }], 'task12-test')
    const result = await ideas.acceptIdea(project.slug, idea!.id)
    const code = result.idea.episode_code!
    const episodePaths = await utils.resolveEpisodePaths(project.slug, code, title)
    accepted.push({ code, title, sidecar: path.join(episodePaths.episode_dir, 'youtube_upload.json') })
  }

  const plan = await plans.upsertPlan(project.slug, {
    name: 'Task 12 all days', platform: 'youtube', account_id: `registry:${CHANNEL}`,
    schedule: {
      weekdays: [0, 1, 2, 3, 4, 5, 6], time_local: '12:00', timezone: 'UTC', start_date: '2030-01-01',
    },
    defaults: { privacy_status: 'private' },
  })
  await plans.setActivePlanId(project.slug, 'youtube', `registry:${CHANNEL}`, plan.id)
  return { slug: project.slug, planId: plan.id, episodes: accepted }
}

async function failRenameTo(target: string, action: () => Promise<any>): Promise<any> {
  const realRename = fs.rename
  ;(fs as any).rename = async (from: any, to: any) => {
    if (String(to) === target) throw Object.assign(new Error('injected second sidecar rename failure'), { code: 'EACCES' })
    return realRename(from, to)
  }
  try {
    return await action()
  } finally {
    ;(fs as any).rename = realRename
  }
}

test('plan apply compensates the first sidecar when the second sidecar write fails', async () => {
  // Route-level reproduction: current source returns an error after EP0001 was
  // persisted, leaving a partial plan. The desired invariant is checked on the
  // actual sidecar, not inferred from a proposed helper API.
  const { slug, planId, episodes } = await scenario()
  const body = {
    plan_id: planId,
    expected_channel_id: CHANNEL,
    episode_codes: episodes.map(episode => episode.code),
  }
  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/preview`).send(body)
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.assignments.length, 2)

  const failed = await failRenameTo(episodes[1]!.sidecar, () => request(app)
    .post(`/api/projects/${slug}/youtube/plan/apply`)
    .send({ ...body, confirm: true, expected_assignments: preview.body.assignments }))

  assert.ok(failed.status >= 400, JSON.stringify(failed.body))
  await assert.rejects(fs.stat(episodes[0]!.sidecar), { code: 'ENOENT' },
    'the successfully written prefix must be compensated back to no local claim')
})

test('relayout apply compensates the first sidecar when the second sidecar write fails', async () => {
  // Same production loop through the re-layout endpoint, starting from two
  // real prior values so compensation must restore data rather than delete it.
  const { slug, planId, episodes } = await scenario()
  const old = {
    [episodes[0]!.code]: '2029-11-01T12:00:00.000Z',
    [episodes[1]!.code]: '2029-11-02T12:00:00.000Z',
  }
  await plans.writeItemSchedule(slug, old)
  const body = {
    plan_id: planId,
    expected_channel_id: CHANNEL,
    episode_codes: episodes.map(episode => episode.code),
    start_date: '2030-02-01',
  }
  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/preview`).send(body)
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.assignments.length, 2)

  const failed = await failRenameTo(episodes[1]!.sidecar, () => request(app)
    .post(`/api/projects/${slug}/youtube/plan/relayout/apply`)
    .send({ ...body, confirm: true, expected_assignments: preview.body.assignments }))

  assert.ok(failed.status >= 400, JSON.stringify(failed.body))
  const first = JSON.parse(await fs.readFile(episodes[0]!.sidecar, 'utf8'))
  assert.equal(first.scheduled_for, old[episodes[0]!.code],
    'the successfully written prefix must be compensated to its reviewed prior value')
})

for (const compensationFailure of ['conflict', 'io'] as const) {
  test(`relayout names the uncertain episode when compensation hits ${compensationFailure}`, async () => {
    const { slug, planId, episodes } = await scenario()
    const old = {
      [episodes[0]!.code]: '2029-11-01T12:00:00.000Z',
      [episodes[1]!.code]: '2029-11-02T12:00:00.000Z',
    }
    await plans.writeItemSchedule(slug, old)
    const body = {
      plan_id: planId,
      expected_channel_id: CHANNEL,
      episode_codes: episodes.map(episode => episode.code),
      start_date: '2030-02-01',
    }
    const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/preview`).send(body)
    assert.equal(preview.status, 200, JSON.stringify(preview.body))

    const firstPath = episodes[0]!.sidecar
    const secondPath = episodes[1]!.sidecar
    const concurrentDate = '2030-03-03T12:00:00.000Z'
    const concurrentSecondDate = '2030-03-04T12:00:00.000Z'
    const realRename = fs.rename
    let firstRenames = 0
    ;(fs as any).rename = async (from: any, to: any) => {
      if (String(to) === firstPath) {
        firstRenames += 1
        if (compensationFailure === 'io' && firstRenames === 2) {
          throw Object.assign(new Error('injected compensation I/O failure'), { code: 'EACCES' })
        }
        const renamed = await realRename(from, to)
        if (firstRenames === 1) {
          // A concurrent writer changes EP0002 after preview, so the later
          // production CAS fails rather than an injected raw filesystem write.
          const secondConcurrent = JSON.parse(await fs.readFile(secondPath, 'utf8'))
          await fs.writeFile(secondPath, JSON.stringify({ ...secondConcurrent, scheduled_for: concurrentSecondDate }))
          if (compensationFailure === 'conflict') {
            const firstConcurrent = JSON.parse(await fs.readFile(firstPath, 'utf8'))
            await fs.writeFile(firstPath, JSON.stringify({ ...firstConcurrent, scheduled_for: concurrentDate }))
          }
        }
        return renamed
      }
      return realRename(from, to)
    }
    let failed: any
    try {
      failed = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/apply`)
        .send({ ...body, confirm: true, expected_assignments: preview.body.assignments })
    } finally {
      ;(fs as any).rename = realRename
    }

    assert.equal(failed.status, 500, JSON.stringify(failed.body))
    assert.equal(failed.body.code, 'YOUTUBE_PLAN_PARTIAL_WRITE')
    assert.deepEqual(failed.body.committed_episode_codes, [])
    assert.deepEqual(failed.body.uncertain_episode_codes, [episodes[0]!.code])
    assert.match(failed.body.detail, new RegExp(episodes[0]!.code))
    assert.match(failed.body.detail, /Refresh the Upload Center and review/i)
    const first = JSON.parse(await fs.readFile(firstPath, 'utf8'))
    assert.equal(
      first.scheduled_for,
      compensationFailure === 'conflict' ? concurrentDate : preview.body.assignments[0].publishAt,
      'failed compensation must not claim or manufacture the reviewed prior value',
    )
  })
}
