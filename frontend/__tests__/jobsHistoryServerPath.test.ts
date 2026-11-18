/**
 * The Jobs page's list comes from the server.
 *
 * WHY THIS FILE EXISTS. The page used to hold every job of every channel in
 * memory, streamed to it on every page by the dashboard layout. The live half
 * is still streamed (queued/running/paused — few rows, and they drive the
 * reorder buttons and the badges); the finished half is now a server read.
 * This file pins the wiring that makes the page still show, search and select
 * over the whole scope:
 *   1. the universal list is the streamed live rows PLUS the server's history
 *      rows — never the stream alone, which would silently drop a channel's past;
 *   2. the search and "Select All Matching" run over that same composed list,
 *      so narrowing and bulk selection still cover every matching row;
 *   3. the history read is one call per scope, to the history endpoint, with the
 *      channel sent to the server when one is chosen.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { useJobHistory } from '../composables/useJobHistory.js'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)

/** Run `body` with a stubbed `$fetch`, restoring whatever was there before. */
async function withFetch<T>(handler: (url: string) => Promise<unknown>, body: () => Promise<T>): Promise<T> {
  const original = (globalThis as any).$fetch
  ;(globalThis as any).$fetch = handler
  try { return await body() } finally { (globalThis as any).$fetch = original }
}

test('both scopes merge streamed live rows with server history without duplicates', () => {
  assert.match(page, /const history = useJobHistory\(\)/)
  assert.match(page, /const scopedJobs = computed\(\(\) => \{\n\s*const seen = new Set\(streamedJobs\.value\.map\(job => job\.job_id\)\)\n\s*return \[\.\.\.streamedJobs\.value, \.\.\.history\.rows\.value\.filter\(job => !seen\.has\(job\.job_id\)\)\]/,
    'channel and universal views must both include terminal history, while a streamed row wins during settlement')
  assert.match(page, /const jobs = computed\(\(\) => scopedJobs\.value\.map\(job => jobDetails\.withDetail\(job\)\)/)
})

test('search and Select All Matching run over that same composed list', () => {
  assert.match(page, /const projectScopedJobs = computed\(\(\) => \{[\s\S]{0,200}return jobs\.value/)
  assert.match(page, /const eligibleCleanupJobs = computed\(\(\) => filteredJobs\.value\.filter/)
  assert.match(page, /function selectCleanupJobs[\s\S]{0,400}selectedCleanupIds\.value = new Set\(eligibleCleanupJobs\.value/)
  assert.match(page, /\.filter\(job => matchesEpisodeSearch\(job, episodeSearch\.value\)\)/,
    'the search reads the same list the server rows were merged into')
})

test('the history read follows the active scope, resets on scope changes, and reloads terminal rows', () => {
  assert.match(page, /if \(isUniversal\.value\) \{\n\s*const query = projectFilter\.value === 'all' \? \{\} : \{ project: projectFilter\.value \}\n\s*await Promise\.all\(\[\n\s*history\.load\('\/jobs\/all\/history', query\),\n\s*\]\)/,
    'the universal scope sends the selected channel to the server')
  assert.match(page, /await Promise\.all\(\[\n\s*history\.load\(`\/projects\/\$\{slug\.value\}\/jobs\/history`\),\n\s*\]\)/,
    'a channel uses its own history endpoint')
  assert.match(page, /watch\(\[isUniversal, projectFilter, slug\], \(\) => \{\n\s*history\.reset\(\)\n\s*void loadJobHistory\(\)\n\s*\}, \{ immediate: true \}\)/,
    'visible rows and in-flight loads are invalidated when channel or scope changes')
  assert.match(page, /watch\(\(\) => projectQueue\.jobs\.value\.map\(job => `\$\{job\.job_id\}:\$\{job\.status\}`\)\.join\('\|'\), \(\) => \{\n\s*if \(!isUniversal\.value\) scheduleHistoryRefresh\(500\)/,
    'a channel row leaving the active stream refreshes authoritative history without observing progress churn')
  assert.match(page, /watch\(\(\) => universalQueue\.jobs\.value\.map\(job => `\$\{job\.job_id\}:\$\{job\.status\}`\)\.join\('\|'\), \(\) => \{\n\s*if \(isUniversal\.value\) scheduleHistoryRefresh\(500\)/,
    'universal terminal transitions continue refreshing fleet history')
})

test('a history row is a row without its log: the card reads the small fields it carries', () => {
  assert.match(page, /const line = rowSummaryLine\(job as any\)/)
  assert.match(page, /return rowProgressCounter\(job as any\)/)
  assert.match(page, /return deriveOutputDir\(job as any\)/)
})

test('the history read asks for every matching row and keeps the server total', async () => {
  const urls: string[] = []
  const history = useJobHistory()
  await withFetch(async url => {
    urls.push(url)
    return { jobs: [{ job_id: 'a' }, { job_id: 'b' }], total: 7 }
  }, () => history.load('/jobs/all/history', { project: 'channel-one' }))

  assert.equal(urls.length, 1)
  assert.ok(urls[0]!.includes('/jobs/all/history?'), urls[0])
  assert.ok(urls[0]!.includes('all=1'), 'the page needs the whole matching set, not one page')
  assert.ok(urls[0]!.includes('project=channel-one'), 'the scope is narrowed on the server')
  assert.deepEqual(history.rows.value.map(job => (job as any).job_id), ['a', 'b'])
  assert.equal(history.total.value, 7, 'the server counts matches, which is what select-all needs')
})

test('a failed history read never looks like a channel with no finished work', async () => {
  const history = useJobHistory()
  await withFetch(async () => ({ jobs: [{ job_id: 'a' }], total: 1 }), () => history.load('/jobs/all/history'))
  assert.equal(history.rows.value.length, 1)

  await withFetch(async () => { throw Object.assign(new Error('boom'), { data: { detail: 'Could not load job history.' } }) },
    () => history.load('/jobs/all/history'))
  assert.equal(history.error.value, 'Could not load job history.')
  assert.equal(history.rows.value.length, 0)
  assert.equal(history.loading.value, false)
})

test('a slow answer for an abandoned scope cannot replace a newer one', async () => {
  let releaseFirst!: (value: unknown) => void
  const first = new Promise(resolve => { releaseFirst = resolve })
  const history = useJobHistory()
  let call = 0
  await withFetch(async () => {
    call += 1
    if (call === 1) return first
    return { jobs: [{ job_id: 'newer' }], total: 1 }
  }, async () => {
    const slow = history.load('/jobs/all/history', { project: 'old' })
    await history.load('/jobs/all/history', { project: 'new' })
    releaseFirst({ jobs: [{ job_id: 'stale' }], total: 99 })
    await slow
  })
  assert.deepEqual(history.rows.value.map(job => (job as any).job_id), ['newer'])
  assert.equal(history.total.value, 1)
})

test('a confirmed single clear drops its row at once and cannot be undone by a pre-clear read', async () => {
  let releasePreClear!: (value: unknown) => void
  const preClear = new Promise(resolve => { releasePreClear = resolve })
  const history = useJobHistory()
  let call = 0
  await withFetch(async () => {
    call += 1
    if (call === 1) return { jobs: [{ job_id: 'gone' }, { job_id: 'kept' }], total: 2 }
    if (call === 2) return preClear
    return { jobs: [{ job_id: 'kept' }], total: 1 }
  }, async () => {
    await history.load('/jobs/all/history')
    const inFlight = history.load('/jobs/all/history')
    history.removeIds(['gone'])
    assert.deepEqual(history.rows.value.map(job => (job as any).job_id), ['kept'])
    assert.equal(history.total.value, 1)
    assert.equal(history.loading.value, false, 'the discarded read must not leave the list loading')

    releasePreClear({ jobs: [{ job_id: 'gone' }, { job_id: 'kept' }], total: 2 })
    await inFlight
    assert.deepEqual(history.rows.value.map(job => (job as any).job_id), ['kept'],
      'an answer begun before the clear must not restore the removed row')

    await history.load('/jobs/all/history')
    assert.deepEqual(history.rows.value.map(job => (job as any).job_id), ['kept'])
    assert.equal(history.total.value, 1)
  })
})

test('a bulk clear invalidates a read begun before it, so its answer cannot land', async () => {
  let releasePreClear!: (value: unknown) => void
  const preClear = new Promise(resolve => { releasePreClear = resolve })
  const history = useJobHistory()
  let call = 0
  await withFetch(async () => {
    call += 1
    if (call === 1) return { jobs: [{ job_id: 'a' }], total: 1 }
    if (call === 2) return preClear
    return { jobs: [], total: 0 }
  }, async () => {
    await history.load('/jobs/all/history')
    const inFlight = history.load('/jobs/all/history')
    history.invalidate()
    releasePreClear({ jobs: [{ job_id: 'a' }, { job_id: 'b' }], total: 9 })
    await inFlight
    assert.deepEqual(history.rows.value.map(job => (job as any).job_id), ['a'],
      'the pre-clear rows stay until the authoritative reload')
    assert.equal(history.total.value, 1)
    assert.equal(history.loading.value, false)

    await history.load('/jobs/all/history')
    assert.deepEqual(history.rows.value, [])
    assert.equal(history.total.value, 0)
  })
})

test('a confirmed clear invalidates stale reads and reloads history in either scope', () => {
  assert.match(page, /history\.invalidate\(\)/)
  assert.match(page, /await post\(`\/jobs\/all\/\$\{job\.job_id\}\/clear`, \{\}\)/)
  assert.match(page, /isMissingJobError\(/,
    'a 404 on Clear means the record is already gone, not a refusal')
  assert.match(page, /await post<\{ ok: boolean; cleared: number; bytes: number \}>\('\/jobs\/all\/clear'/)
  assert.match(page, /expected_count: preview\.count/)
  assert.doesNotMatch(page, /\/hide/)
})

test('the toolbar counts use the server clear selector, not the skipped badge', () => {
  assert.match(page, /const finishedCount = computed\(\(\) => removableJobs\.value\.filter\(job =>\n\s*job\.status !== 'error' \|\| isRecoveredFailure\(job\)\)\.length\)/)
  assert.match(page, /const failedCount = computed\(\(\) => removableJobs\.value\.filter\(job =>\n\s*job\.status === 'error' && !isRecoveredFailure\(job\)\)\.length\)/)
})

test('a failed history read is visible with a retry instead of looking like an empty list', () => {
  assert.match(page, /const historyError = computed\(\(\) => history\.error\.value\)/)
  assert.match(page, /<WorkspaceNotice v-if="historyError" tone="warning" title="Finished job history could not be loaded">/)
  assert.match(page, /@click="loadJobHistory">Retry History<\/button>/)
})
