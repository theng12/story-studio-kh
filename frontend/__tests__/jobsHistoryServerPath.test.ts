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

test('the universal list is the live stream plus the server history, never the stream alone', () => {
  assert.match(page, /const history = useJobHistory\(\)/)
  assert.match(page, /const scopedJobs = computed\(\(\) => isUniversal\.value\n?\s*\? \[\.\.\.streamedJobs\.value, \.\.\.history\.rows\.value\]/,
    'a universal list built from the stream alone would drop every finished row')
  assert.match(page, /const jobs = computed\(\(\) => scopedJobs\.value\.map\(job => jobDetails\.withDetail\(job\)\)/)
})

test('search and Select All Matching run over that same composed list', () => {
  assert.match(page, /const projectScopedJobs = computed\(\(\) => \{[\s\S]{0,200}return jobs\.value/)
  assert.match(page, /const eligibleCleanupJobs = computed\(\(\) => filteredJobs\.value\.filter/)
  assert.match(page, /function selectCleanupJobs[\s\S]{0,400}selectedCleanupIds\.value = new Set\(eligibleCleanupJobs\.value/)
  assert.match(page, /\.filter\(job => matchesEpisodeSearch\(job, episodeSearch\.value\)\)/,
    'the search reads the same list the server rows were merged into')
})

test('the history read is one call per scope, and a chosen channel narrows it server-side', () => {
  assert.match(page, /history\.load\('\/jobs\/all\/history'/)
  assert.match(page, /projectFilter\.value === 'all' \? \{\} : \{ project: projectFilter\.value \}/)
  assert.match(page, /watch\(\[isUniversal, projectFilter, slug\], \(\) => \{ void loadJobHistory\(\) \}, \{ immediate: true \}\)/,
    'one read per scope, not one per filter — the page filters these rows itself')
  assert.match(page, /if \(!isUniversal\.value\) \{ history\.reset\(\); return \}/,
    'project mode keeps its own per-project stream whole')
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
