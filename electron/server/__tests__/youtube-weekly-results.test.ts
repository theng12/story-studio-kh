import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { ANALYTICS_SCOPE } from '../lib/youtube-oauth.js'
import { createProject, getProjectDir } from '../services/project-manager.js'
import { assignProjectYouTubeChannel, configureYouTubeApplication } from '../services/youtube-connection-store.js'
import { listWeeklyResults, recomputeWeeklyResult, weeklyResultsTick, monday, setWeeklyResultsEnabled, weeklyResultsEnabled } from '../services/youtube-weekly-results.js'
import type { runReport } from '../lib/youtube-analytics.js'

const channel = 'UC-weekly-results'
const day = 86_400_000
const scopeWithoutAnalytics = 'https://www.googleapis.com/auth/youtube.readonly'
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })
async function grant(scope = ANALYTICS_SCOPE) {
  await saveYouTubeChannelGrantForTest({ channel: { channel_id: channel, title: 'Channel', granted_scopes: [scope] }, tokens: { access_token: 'test-access-private', refresh_token: 'test-refresh-private', expires_at: Date.now() + 3600000, scope } })
}
async function setup(scope = ANALYTICS_SCOPE) {
  const temp = await useTempDataDir(); cleanup = temp.cleanup
  const project = await createProject({ name: 'Weekly results' })
  await configureYouTubeApplication({ client_id: 'weekly-client', client_secret: 'test-client-private' })
  await grant(scope)
  await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: channel, expected_previous_channel_id: null })
  return project.slug
}
const currentMonday = () => Date.parse(`${monday(new Date())}T00:00:00Z`)
const eligibleTime = () => new Date(currentMonday() + 4 * day)
const lastWeek = () => new Date(currentMonday() - 7 * day).toISOString().slice(0, 10)
const report = (value: number | null): typeof runReport => async (_slug, _account, params) => {
  const cols = params.metrics!.split(',')
  if (params.dimensions) return { columnHeaders: [{ name: 'video' }, ...cols.map(name => ({ name }))], rows: [] }
  return { columnHeaders: cols.map(name => ({ name })), rows: value === null ? [] : [cols.map(() => value)] }
}
test('a measured week preserves reported figures', async () => {
  const slug = await setup()
  const result = await recomputeWeeklyResult(slug, lastWeek(), report(42))
  assert.equal(result.metrics.views.state, 'measured'); assert.equal(result.metrics.watch_minutes.value, 42)
  assert.equal(result.complete, true)
})
test('a reported zero differs from an absent row', async () => {
  const slug = await setup(); const week = lastWeek()
  const zero = await recomputeWeeklyResult(slug, week, report(0))
  assert.equal(zero.metrics.views.state, 'measured'); assert.equal(zero.metrics.views.value, 0)
  const missing = await recomputeWeeklyResult(slug, week, report(null))
  assert.equal(missing.metrics.views.state, 'no_data'); assert.equal(missing.metrics.views.value, null)
})
test('missing scope requires reconnect and resumes when scope is granted', async () => {
  const slug = await setup(scopeWithoutAnalytics); const now = eligibleTime()
  let calls = 0
  const fetch: typeof runReport = async (...args) => { calls++; return report(2)(...args) }
  await weeklyResultsTick(now, fetch)
  assert.equal((await listWeeklyResults(slug))[0]?.metrics.views.state, 'reconnect_required')
  await weeklyResultsTick(new Date(now.getTime() + 60_000), fetch)
  assert.equal(calls, 0)
  await grant()
  await weeklyResultsTick(new Date(now.getTime() + 120_000), fetch)
  assert.equal(calls, 6); assert.equal((await listWeeklyResults(slug)).find(r => r.week === lastWeek())?.complete, true)
})
test('rerunning a week replaces one record', async () => {
  const slug = await setup(); const week = lastWeek()
  await recomputeWeeklyResult(slug, week, report(1)); await recomputeWeeklyResult(slug, week, report(2))
  const results = await listWeeklyResults(slug)
  assert.equal(results.length, 1); assert.equal(results[0]?.metrics.views.value, 2)
})
test('startup catches up an eligible missed week', async () => {
  const slug = await setup()
  await weeklyResultsTick(eligibleTime(), report(12))
  const result = (await listWeeklyResults(slug))[0]
  assert.equal(result?.week, lastWeek()); assert.equal(result?.metrics.views.value, 12)
})
test('failure is stored and retried after six hours, then stops after three attempts', async () => {
  const slug = await setup(); const now = eligibleTime(); let calls = 0
  const failing: typeof runReport = async () => { calls++; throw new Error('offline') }
  await weeklyResultsTick(now, failing)
  assert.equal((await listWeeklyResults(slug))[0]?.metrics.views.state, 'unavailable')
  assert.ok((await listWeeklyResults(slug))[0]?.reason)
  await weeklyResultsTick(new Date(now.getTime() + 6 * 3600000), failing)
  await weeklyResultsTick(new Date(now.getTime() + 12 * 3600000), failing)
  await weeklyResultsTick(new Date(now.getTime() + 18 * 3600000), failing)
  assert.equal(calls, 18); assert.equal((await listWeeklyResults(slug))[0]?.attempts, 3)
  const fixed = await recomputeWeeklyResult(slug, lastWeek(), report(7))
  assert.equal(fixed.metrics.views.value, 7)
})
test('stored results contain no credentials', async () => {
  const slug = await setup(); const week = lastWeek()
  await recomputeWeeklyResult(slug, week, report(1))
  const bytes = await fs.readFile(path.join(getProjectDir(slug)!, 'youtube', 'weekly-results', encodeURIComponent(channel), `${week}.json`), 'utf8')
  assert.doesNotMatch(bytes, /test-access-private|test-refresh-private|test-client-private/)
})
test('a failed week is not fetched inside the retry wait', async () => {
  await setup(); const now = eligibleTime(); let calls = 0
  const failing: typeof runReport = async () => { calls++; throw new Error('offline') }
  await weeklyResultsTick(now, failing)
  await weeklyResultsTick(new Date(now.getTime() + 6 * 3600000 - 1), failing)
  assert.equal(calls, 6)
})
test('a week ending fewer than four days ago is skipped', async () => {
  const slug = await setup(); let calls = 0
  const older = new Date(currentMonday() - 14 * day).toISOString().slice(0, 10)
  await recomputeWeeklyResult(slug, older, report(1))
  const fetch: typeof runReport = async (...args) => { calls++; return report(1)(...args) }
  await weeklyResultsTick(new Date(currentMonday() + 4 * day - 1), fetch)
  assert.equal(calls, 0); assert.equal((await listWeeklyResults(slug)).some(r => r.week === lastWeek()), false)
})
test('scheduler can be disabled while manual recompute still works', async () => {
  const slug = await setup(); let calls = 0
  assert.equal(await weeklyResultsEnabled(), true)
  await setWeeklyResultsEnabled(false)
  const fetch: typeof runReport = async (...args) => { calls++; return report(1)(...args) }
  await weeklyResultsTick(eligibleTime(), fetch)
  assert.equal(calls, 0)
  await recomputeWeeklyResult(slug, lastWeek(), fetch)
  assert.equal(calls, 6)
})
