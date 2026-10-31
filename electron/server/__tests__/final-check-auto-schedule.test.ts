import { waitFor } from './_timing.js'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let slug: string
let root: string
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')
let scheduling: typeof import('../services/episode-autoschedule.js')
let checks: typeof import('../lib/final-video-check.js')
let plans: typeof import('../services/upload-plans.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  root = temp.dir
  pm = await import('../services/project-manager.js')
  ideas = await import('../services/idea-manager.js')
  scheduling = await import('../services/episode-autoschedule.js')
  checks = await import('../lib/final-video-check.js')
  plans = await import('../services/upload-plans.js')
  slug = (await pm.createProject({ name: 'Final check scheduling' })).slug
})
after(async () => { await cleanup() })

async function episode(name: string) {
  const [idea] = await ideas.addIdeas(slug, [{ title: name, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '' }], 'test')
  const code = (await ideas.acceptIdea(slug, idea!.id)).idea.episode_code!
  const video = path.join(root, `${code}.mp4`)
  await fs.writeFile(video, 'video')
  return { code, video }
}
async function verdict(video: string, passed: boolean) {
  const stat = await fs.stat(video)
  await checks.storeFinalCheck(video, {
    checked_at: new Date().toISOString(), file: { size: stat.size, mtime_ms: stat.mtimeMs },
    passed, issues: passed ? [] : [{ check: 'black', verdict: 'Black video' }],
    expected: {}, actual: {},
  } as any)
}

test('only a current pass automatically schedules, and each hold explains why', async () => {
  for (const status of ['failed', 'stale', 'unchecked', 'check-error'] as const) {
    const item = await episode(status)
    if (status === 'failed') await verdict(item.video, false)
    if (status === 'stale') { await verdict(item.video, true); await fs.appendFile(item.video, 'new') }
    const result = await scheduling.scheduleCheckedEpisode(slug, item.code, item.video, status === 'check-error')
    assert.equal(result.scheduled, false)
    assert.equal(result.hold?.status, status)
    assert.match(result.reason!, /Run Final Check/)
    assert.deepEqual(await scheduling.readAutoScheduleHold(item.video), result.hold)
    assert.equal((await plans.readItemSchedule(slug))[item.code], undefined)
  }
  const item = await episode('pass')
  await verdict(item.video, true)
  assert.equal((await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)).scheduled, true)
})

test('turning the check switch off restores automatic scheduling', async () => {
  const item = await episode('switch off')
  await pm.updateConfig(slug, { auto_schedule_require_final_check: false } as any)
  try { assert.equal((await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)).scheduled, true) }
  finally { await pm.updateConfig(slug, { auto_schedule_require_final_check: true } as any) }
})

test('a failed final check keeps the finished render successful and records its hold', async () => {
  const item = await episode('finished render')
  await verdict(item.video, false)
  const { finishImportedFinalVideo } = await import('../generators/video.js')
  const job: any = { project_slug: slug, output_lines: [], result: {}, progress: 0 }
  await finishImportedFinalVideo(job, item.code, item.video, 'scene_plan', null)
  assert.equal(job.progress, 100)
  assert.equal(job.result.auto_schedule_hold.status, 'failed')
  assert.ok(job.output_lines.some((line: string) => line.includes('Not automatically scheduled')))
  assert.equal(await fs.readFile(item.video, 'utf8'), 'video')
})

test('the background recheck invokes scheduling when a later verdict passes', async () => {
  const item = await episode('background recheck')
  await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)
  const stat = await fs.stat(item.video)
  checks.__setFinalCheckRunnerForTests(async () => ({
    checked_at: new Date().toISOString(), file: { size: stat.size, mtime_ms: stat.mtimeMs },
    passed: true, issues: [], expected: {}, actual: {},
  }) as any)
  try {
    checks.startFinalCheck(item.video, {} as any, {}, async () => {
      if (await scheduling.readAutoScheduleHold(item.video)) await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)
    })
    await waitFor(() => !checks.finalCheckProgress(item.video).running)
    assert.ok((await plans.readItemSchedule(slug))[item.code])
    assert.equal(await scheduling.readAutoScheduleHold(item.video), null)
  } finally { checks.__setFinalCheckRunnerForTests(null) }
})

test('a later pass schedules once, and a second call changes nothing', async () => {
  const item = await episode('later pass')
  await verdict(item.video, false)
  assert.equal((await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)).hold?.status, 'failed')
  const before = await plans.readItemSchedule(slug)
  await verdict(item.video, true)
  assert.equal((await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)).scheduled, true)
  const after = await plans.readItemSchedule(slug)
  for (const [code, date] of Object.entries(before)) assert.equal(after[code], date)
  assert.equal(await scheduling.readAutoScheduleHold(item.video), null)
  assert.equal((await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)).scheduled, false)
  assert.deepEqual(await plans.readItemSchedule(slug), after)
})

test('a new slot is never in the past, whatever the time of day', async () => {
  const item = await episode('never past')
  await verdict(item.video, true)
  const result = await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)
  assert.ok(Date.parse(result.publish_at!) > Date.now(), result.publish_at)
})

test('a past date with no known channel is left alone; with no video on the channel it is replaced', async () => {
  const connections = await import('../services/youtube-connection-store.js')
  const { saveYouTubeChannelGrantForTest } = await import('./_youtube-connection-test-helper.js')
  const item = await episode('past date')
  await verdict(item.video, true)
  const past = new Date(Date.now() - 3_600_000).toISOString()
  await plans.writeItemSchedule(slug, { ...(await plans.readItemSchedule(slug)), [item.code]: past })
  assert.equal((await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)).scheduled, false)
  assert.equal((await plans.readItemSchedule(slug))[item.code], past, 'no channel to ask: not ours to replace')
  await connections.configureYouTubeApplication({ client_id: 'c', client_secret: 's' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC_past', title: 'Past', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: slug, channel_id: 'UC_past', expected_previous_channel_id: null } as any)
  const result = await scheduling.scheduleCheckedEpisode(slug, item.code, item.video)
  assert.equal(result.scheduled, true, JSON.stringify(result))
  assert.ok(Date.parse((await plans.readItemSchedule(slug))[item.code]!) > Date.now())
})
