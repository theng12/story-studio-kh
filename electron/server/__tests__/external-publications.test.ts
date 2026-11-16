/**
 * Publications made outside Story — import rules and coverage counting (2026-11-16).
 *
 * Only a verified entry with a real date counts; import never verifies; bad or guessed dates and
 * duplicates are refused with the row number; unlinked and dismissed rows never count.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  externalCoverage,
  parseExternalPublishedAt,
  validateExternalImport,
  type ExternalPublication,
} from '../contracts/external-publications.js'

test('a real calendar day or an ISO instant with a zone is accepted; a guessed date is not', () => {
  assert.equal(parseExternalPublishedAt('2026-03-05'), '2026-03-05')
  assert.equal(parseExternalPublishedAt('2026-02-30'), null, 'February 30 does not exist')
  assert.equal(parseExternalPublishedAt('2026-03-05T10:00:00Z'), '2026-03-05T10:00:00.000Z')
  assert.equal(parseExternalPublishedAt('2026-03-05T10:00:00+07:00'), '2026-03-05T03:00:00.000Z')
  assert.equal(parseExternalPublishedAt('2026-03-05T10:00:00'), null, 'no zone is not a real instant')
  assert.equal(parseExternalPublishedAt('March 5'), null)
  assert.equal(parseExternalPublishedAt(''), null)
})

test('imports arrive unlinked, and a bad row refuses the file', () => {
  const { entries, refusals } = validateExternalImport([
    { title: 'A published episode', published_at: '2026-03-05', video_id: 'abc123', episode_code: 'EP0001' },
    { title: '', published_at: '2026-03-06' },
    { title: 'Bad date', published_at: 'yesterday' },
  ], [])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.state, 'unlinked')
  assert.equal(entries[0]!.verified_at, null)
  assert.deepEqual(refusals.map(r => r.row), [2, 3])
  assert.match(refusals[0]!.reason, /title is required/)
  assert.match(refusals[1]!.reason, /not a real YYYY-MM-DD/)
})

test('a duplicate video id, date+episode or id is refused', () => {
  const existing = [{
    id: 'abc123', video_id: 'abc123', video_url: undefined, published_at: '2026-03-01', episode_code: 'EP0001',
  }] as unknown as ExternalPublication[]
  const { entries, refusals } = validateExternalImport([
    { title: 'Same video', published_at: '2026-04-01', video_id: 'abc123' },
    { title: 'Same episode day', published_at: '2026-03-01', episode_code: 'EP0001' },
    { title: 'Fresh', published_at: '2026-05-01' },
  ], existing)
  assert.equal(entries.length, 1)
  assert.deepEqual(refusals.map(r => r.row), [1, 2])
})

test('coverage counts only verified entries and names overlaps with local coverage', () => {
  const entries = [
    { state: 'verified', published_at: '2026-03-05' },
    { state: 'unlinked', published_at: '2026-03-06' },
    { state: 'dismissed', published_at: '2026-03-07' },
    { state: 'verified', published_at: '2026-03-08' },
  ] as unknown as ExternalPublication[]
  const coverage = externalCoverage(entries, new Set(['2026-03-08']))
  assert.equal(coverage.verified, 2)
  assert.deepEqual(coverage.days, ['2026-03-05', '2026-03-08'])
  assert.deepEqual(coverage.overlappingLocal, ['2026-03-08'], 'shown, never double-counted silently')
})
