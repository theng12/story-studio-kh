import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { ANALYTICS_SCOPE } from '../lib/youtube-oauth.js'
import { createProject, getProjectDir } from '../services/project-manager.js'
import { assignProjectYouTubeChannel, configureYouTubeApplication } from '../services/youtube-connection-store.js'
import { listWeeklyResults, recomputeWeeklyResult, weeklyResultsTick, monday } from '../services/youtube-weekly-results.js'
import type { runReport } from '../lib/youtube-analytics.js'

const channel = 'UC-weekly-results'
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })
async function setup(scope = ANALYTICS_SCOPE) {
  const temp = await useTempDataDir(); cleanup = temp.cleanup
  const project = await createProject({ name: 'Weekly results' })
  await configureYouTubeApplication({ client_id: 'weekly-client', client_secret: '{{SECRET_rgeiu7wv}}' })
  await saveYouTubeChannelGrantForTest({ channel: { channel_id: channel, title: 'Channel', granted_scopes: [scope] }, tokens: { access_token: 'weekly-secret-token', refresh_token: 'weekly-secret-refresh', expires_at: Date.now() + 3600000, scope } })
  await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: channel, expected_previous_channel_id: null })
  return project.slug
}
const lastWeek = () => new Date(Date.parse(`${monday(new Date())}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10)
const report = (value: number | null): typeof runReport => async (_slug, _account, params) => {
  const cols = params.metrics!.split(',')
  if (params.dimensions) return { columnHeaders: [{ name: 'video' }, ...cols.map(name => ({ name }))], rows: [] }
  return { columnHeaders: cols.map(name => ({ name })), rows: value === null ? [] : [cols.map(() => value)] }
}
test('measured zeros are distinct from no data and reruns replace one week', async () => {
  const slug = await setup(); const week = lastWeek()
  const zero = await recomputeWeeklyResult(slug, week, report(0))
  assert.equal(zero.metrics.views.state, 'measured'); assert.equal(zero.metrics.views.value, 0)
  const missing = await recomputeWeeklyResult(slug, week, report(null))
  assert.equal(missing.metrics.views.state, 'no_data'); assert.equal(missing.metrics.views.value, null)
  const measured = await recomputeWeeklyResult(slug, week, report(42))
  assert.equal(measured.metrics.watch_minutes.value, 42)
  assert.equal((await listWeeklyResults(slug)).length, 1)
  const bytes = await fs.readFile(path.join(getProjectDir(slug)!, 'youtube', 'weekly-results', encodeURIComponent(channel), `${week}.json`), 'utf8')
  assert.doesNotMatch(bytes, /weekly-secret-token|weekly-secret-refresh|weekly-secret-client/)
})
test('missing analytics scope is stored as reconnect required', async () => {
  const slug = await setup('https://www.googleapis.com/auth/youtube.readonly')
  const value = await recomputeWeeklyResult(slug, lastWeek(), report(2))
  assert.equal(value.metrics.views.state, 'reconnect_required')
  assert.equal((await listWeeklyResults(slug))[0]?.complete, false)
})
test('failure is recorded and a later recomputation retries', async () => {
  const slug = await setup(); const week = lastWeek()
  const failure = await recomputeWeeklyResult(slug, week, async () => { throw new Error('offline') })
  assert.equal(failure.metrics.views.state, 'unavailable'); assert.ok(failure.reason)
  const retried = await recomputeWeeklyResult(slug, week, report(7))
  assert.equal(retried.metrics.views.value, 7); assert.equal(retried.complete, true)
})
test('startup catch-up records a missed week even when the grant lacks scope', async () => {
  const slug = await setup('https://www.googleapis.com/auth/youtube.readonly')
  await weeklyResultsTick()
  assert.equal((await listWeeklyResults(slug))[0]?.week, lastWeek())
  assert.equal((await listWeeklyResults(slug))[0]?.metrics.views.state, 'reconnect_required')
})
