import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ACTIVE_LIST_CAP, HISTORY_PAGE_SIZE, bulkConfirmOptions, capList, controlLabel, episodeQueryValue,
  isPaidWork, matchesEpisodeSearch, pageCount, pageSlice,
} from '../utils/jobs-list.js'

const page = readFileSync(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url), 'utf8')
const job = { episode_id: 'EP0123', title: 'The Last Ferry Home' }

test('search matches episode code or episode title, ignoring case', () => {
  assert.equal(matchesEpisodeSearch(job, 'ep0123'), true)
  assert.equal(matchesEpisodeSearch(job, 'ferry'), true)
  assert.equal(matchesEpisodeSearch(job, '  FERRY HOME '), true)
  assert.equal(matchesEpisodeSearch(job, 'EP0124'), false)
  assert.equal(matchesEpisodeSearch({ episode_id: null, title: undefined }, 'EP'), false)
  assert.equal(matchesEpisodeSearch({}, ''), true, 'an empty search hides nothing')
})

test('?episode_id= is read as one string whatever shape the router gives', () => {
  assert.equal(episodeQueryValue('EP0123'), 'EP0123')
  assert.equal(episodeQueryValue(['EP0007', 'EP0008']), 'EP0007')
  assert.equal(episodeQueryValue(undefined), '')
  assert.equal(episodeQueryValue(null), '')
})

test('history pages hold 50 and an out-of-range page clamps to a real one', () => {
  const rows = Array.from({ length: 120 }, (_, i) => i)
  assert.equal(HISTORY_PAGE_SIZE, 50)
  assert.equal(pageCount(120), 3)
  assert.equal(pageCount(0), 1)
  assert.deepEqual(pageSlice(rows, 1).slice(0, 2), [0, 1])
  assert.equal(pageSlice(rows, 1).length, 50)
  assert.deepEqual(pageSlice(rows, 3), rows.slice(100))
  assert.deepEqual(pageSlice(rows, 9), rows.slice(100))
})

test('the Active list caps at 25 until Show All', () => {
  const rows = Array.from({ length: 40 }, (_, i) => i)
  assert.equal(ACTIVE_LIST_CAP, 25)
  assert.equal(capList(rows, false).length, 25)
  assert.equal(capList(rows, true).length, 40)
  assert.equal(capList(rows.slice(0, 3), false).length, 3)
})

test('paid work uses the page’s own rule: Gateway requests that are not all free fleet work', () => {
  assert.equal(isPaidWork({ genstudio_jobs: [{ model_id: 'openai::gpt-image' }] }), true)
  assert.equal(isPaidWork({ genstudio_jobs: [{ model_id: 'studio-hub::qwen' }] }), false)
  assert.equal(isPaidWork({ genstudio_jobs: [{ model_id: 'studio-hub::qwen' }, { model_id: 'fal::flux' }] }), true)
  assert.equal(isPaidWork({ genstudio_jobs: [] }), false)
  assert.equal(isPaidWork({}), false)
})

test('Retry confirmation states the count and adds the credits note only when paid work is included', () => {
  const free = bulkConfirmOptions('retry', 12, 0)
  assert.equal(free.title, 'Retry 12 failed jobs?')
  assert.doesNotMatch(free.message, /credits/)
  assert.match(bulkConfirmOptions('retry', 12, 3).message, /3 of them include paid work, so this may use credits/)
  assert.match(bulkConfirmOptions('retry', 2, 2).message, /These include paid work, so this may use credits/)
  assert.equal(bulkConfirmOptions('retry', 1).title, 'Retry 1 failed job?')
})

test('Repair confirmation states the count and that it never charges', () => {
  const repair = bulkConfirmOptions('repair', 8)
  assert.equal(repair.title, 'Repair 8 failed jobs?')
  assert.match(repair.message, /Never generates anything new or charges/)
})

test('row buttons keep the wording the backend chose', () => {
  // "Hide from list" is this client's own button (the restorable replacement
  // for "Remove From List"). Every other label is the server's, written in
  // sentence case, and it is rendered as it was written.
  assert.equal(controlLabel({ action: 'clear-history', label: 'Hide from list' }), 'Hide from list')
  assert.equal(controlLabel({ action: 'return-later', label: 'Checking provider status' }), 'Checking provider status')
  assert.equal(controlLabel({ action: 'cancel-before-submit', label: 'Cancel' }), 'Cancel')
  assert.equal(controlLabel({ action: 'pause-submissions', label: 'Pause new work' }), 'Pause new work')
})

test('Jobs wires search, deep link, paging, the Active cap and both confirmations', () => {
  assert.match(page, /v-model="episodeSearch"/)
  assert.match(page, /const episodeSearch = ref\(episodeQueryValue\(route\.query\.episode_id\)\)/)
  assert.match(page, /router\.replace\(\{ query: \{ \.\.\.route\.query, episode_id: next \} \}\)/)
  assert.match(page, /\.filter\(job => matchesEpisodeSearch\(job, episodeSearch\.value\)\)/)
  assert.match(page, /pageSlice\(historyJobs\.value, currentPage\.value\)/)
  assert.match(page, /v-for="job in visibleActiveJobs"/)
  assert.match(page, /Show All \{\{ activeJobs\.length \}\}/)
  assert.match(page, /bulkConfirmOptions\('retry', triage\.retry\.length, paid\)/)
  assert.match(page, /!chained && !await useConfirm\(\)\.ask\(bulkConfirmOptions\('repair'/)
  assert.match(page, /\.map\(control => \(\{ \.\.\.control, label: controlLabel\(control\) \}\)\)/)
})

test('Jobs shows when the list was loaded, wired to the existing refresh', () => {
  assert.match(page, /<UpdatedAgo class="jobs-updated-ago" :at="jobsLoadedAt" :busy="refreshingJobs" @refresh="refreshVisibleJobs" \/>/)
  assert.match(page, /watch\(streamedJobs, \(\) => \{ if \(!jobsLoading\.value\) jobsLoadedAt\.value = Date\.now\(\) \}/)
})

test('capacity jargon sits behind one plain "Gateway capacity" disclosure', () => {
  const start = page.indexOf('<details class="genstudio-capacity">')
  const end = page.indexOf('</details>', start)
  assert.ok(start > -1 && end > start)
  const inside = page.slice(start, end)
  assert.match(inside, /<summary>Gateway capacity<\/summary>/)
  assert.match(inside, /standard lanes/)
  assert.match(inside, /Account capacity is unverified/)
  const template = page.slice(0, page.indexOf('</template>\n\n<script'))
  // Visible text and attributes only — template comments may name the jargon.
  const outside = (template.slice(0, start) + template.slice(end)).replace(/<!--[\s\S]*?-->/g, '')
  assert.doesNotMatch(outside, /\blanes\b|reconcil|unverified/i)
})

test('one action vocabulary and channel wording on the page', () => {
  assert.doesNotMatch(page, /Redo failed jobs|Check on running jobs|Retry all \(/)
  assert.doesNotMatch(page, /'Project Jobs'|>This project<|>All projects<|'All projects'/)
  assert.match(page, /Hide Finished From List \(\$\{finishedCount\}\)/)
  assert.match(page, /Hide Failed From List \(\$\{failedCount\}\)/)
})
