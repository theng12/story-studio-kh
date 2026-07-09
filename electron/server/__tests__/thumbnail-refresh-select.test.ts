/**
 * v1.0.524 — selectEpisodesNeedingThumbnail: which uploaded episodes the
 * backfill targets. Must only touch videos on the ACTIVE account, skip deleted
 * ones, and honour missing-vs-all.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { selectEpisodesNeedingThumbnail, type RefreshRow } from '../generators/youtube-thumbnail-refresh.js'

function row(over: Partial<RefreshRow>): RefreshRow {
  return {
    episode_code: 'EP0001', title: 't', episode_dir: '/d', sidecar_path: '/d/youtube_upload.json',
    video_id: 'vid', account_id: 'acct-A', thumbnail_set: false, deleted_at: null, ...over,
  }
}

describe('selectEpisodesNeedingThumbnail', () => {
  const rows = [
    row({ episode_code: 'EP01', thumbnail_set: false }),                       // needs it
    row({ episode_code: 'EP02', thumbnail_set: true }),                        // already set
    row({ episode_code: 'EP03', video_id: '' }),                              // not uploaded
    row({ episode_code: 'EP04', deleted_at: '2026-01-01' }),                  // deleted on YT
    row({ episode_code: 'EP05', account_id: 'acct-B' }),                      // other channel
  ]

  test("mode 'missing' → only uploaded, active-account, not-deleted, not-yet-set", () => {
    const got = selectEpisodesNeedingThumbnail(rows, { mode: 'missing', accountId: 'acct-A' })
    assert.deepEqual(got.map(r => r.episode_code), ['EP01'])
  })

  test("mode 'all' → every uploaded active-account non-deleted video (incl. already-set)", () => {
    const got = selectEpisodesNeedingThumbnail(rows, { mode: 'all', accountId: 'acct-A' })
    assert.deepEqual(got.map(r => r.episode_code), ['EP01', 'EP02'])
  })

  test('account filter isolates channels', () => {
    const got = selectEpisodesNeedingThumbnail(rows, { mode: 'all', accountId: 'acct-B' })
    assert.deepEqual(got.map(r => r.episode_code), ['EP05'])
  })
})
