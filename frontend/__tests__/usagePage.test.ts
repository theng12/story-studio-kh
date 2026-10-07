/**
 * The Usage page went blank on the mini (1.4.257): the Gateway's account overview publishes no
 * `active_jobs` / `completed_jobs`, the page called `.toLocaleString()` on them, render threw, and
 * everything — the new Back link included — vanished a second after it appeared.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const usage = readFileSync(new URL('../pages/usage.vue', import.meta.url), 'utf8')
const template = usage.slice(0, usage.indexOf('<script'))

test('no figure in the template is formatted without the guard', () => {
  assert.doesNotMatch(template, /\.toLocaleString\(\)/, 'every number goes through count()')
  assert.doesNotMatch(template, /overview\.(active_jobs|completed_jobs)/, 'fields the Gateway does not publish are not read')
  assert.match(usage, /function count\(value: unknown\): string \{\s*return typeof value === 'number' && Number\.isFinite\(value\) \? value\.toLocaleString\(\) : '—'/)
})

test('the guard shows a dash for an unpublished figure, never a made-up 0', () => {
  const body = usage.match(/function count\(value: unknown\): string \{([\s\S]*?)\n\}/)![1]
  const count = new Function('value', body) as (value: unknown) => string
  assert.equal(count(undefined), '—')
  assert.equal(count(null), '—')
  assert.equal(count(Number.NaN), '—')
  assert.equal(count(0), '0')
  assert.equal(count(1834), (1834).toLocaleString())
})

test('credit columns and empty sections only appear when they say something', () => {
  assert.match(usage, /const showCreditColumns = computed/)
  assert.match(template, /<template v-if="showCreditColumns"><th class="num">Held credits<\/th>/)
  assert.match(template, /No credits were held or charged for these jobs\./)
  assert.match(template, /<section v-if="!snapshot\.history_error && snapshot\.credit_activity\.items\.length" class="card">/)
  assert.match(template, /v-if="snapshot\?\.overview\.app_links\?\.billing"/, 'no disabled Buy button when billing is not offered')
  assert.match(template, /<span>Running now<\/span>[\s\S]*paid_active_jobs[\s\S]*paid_concurrency_limit/)
})
