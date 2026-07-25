import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_WHATS_NEW_ENTRIES,
  MAX_WHATS_NEW_REQUEST_LIMIT,
  MAX_WHATS_NEW_REQUEST_OFFSET,
  parseChangelog,
} from '../routes/changelog.js'

function makeChangelog(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const version = count - index
    return `## v1.0.${version} — 2026-07-24\n\nRelease ${version} details.`
  }).join('\n\n')
}

test('What\'s New keeps only the newest 20 changelog entries', () => {
  const entries = parseChangelog(makeChangelog(25))

  assert.equal(entries.length, MAX_WHATS_NEW_ENTRIES)
  assert.equal(entries[0]?.version, '1.0.25')
  assert.equal(entries.at(-1)?.version, '1.0.6')
  assert.equal(entries.some(entry => entry.version === '1.0.5'), false)
})

test('What\'s New retains every entry when the changelog has fewer than 20', () => {
  const entries = parseChangelog(makeChangelog(3))

  assert.deepEqual(
    entries.map(entry => entry.version),
    ['1.0.3', '1.0.2', '1.0.1'],
  )
})

test('expanded changelog reads can request a larger bounded release history', () => {
  const entries = parseChangelog(makeChangelog(MAX_WHATS_NEW_REQUEST_LIMIT + 10), MAX_WHATS_NEW_REQUEST_LIMIT + 1)
  assert.equal(entries.length, MAX_WHATS_NEW_REQUEST_LIMIT + 1)
  assert.equal(entries.at(-1)?.version, '1.0.10')
})

test('release history paging keeps enough headroom for the bounded offset', () => {
  assert.ok(MAX_WHATS_NEW_REQUEST_OFFSET > MAX_WHATS_NEW_REQUEST_LIMIT)
})
