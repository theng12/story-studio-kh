/**
 * Background music default (owner, 2026-10-26, after DM0018/PR0039 were mixed
 * with an 8% bed that buried the Khmer narration): 6% under the narration is
 * the starting level, and it applies to an UNSET value only. A stated value —
 * the page's control, a saved preset — is the customer's choice and is never
 * rewritten (AGENTS.md §5).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { DEFAULT_BACKGROUND_MUSIC_VOLUME, resolveBackgroundMusicVolume } = await import('../generators/audio-merge.js')

test('an unset level starts at 6%', () => {
  assert.equal(DEFAULT_BACKGROUND_MUSIC_VOLUME, 0.06)
  assert.deepEqual(resolveBackgroundMusicVolume(undefined), { volume: 0.06, defaulted: true })
  assert.deepEqual(resolveBackgroundMusicVolume(null), { volume: 0.06, defaulted: true })
  assert.deepEqual(resolveBackgroundMusicVolume(''), { volume: 0.06, defaulted: true })
  assert.deepEqual(resolveBackgroundMusicVolume(Number.NaN), { volume: 0.06, defaulted: true })
})

test('a stated level — a preset at 8%, a customer at 3% — passes through untouched', () => {
  assert.deepEqual(resolveBackgroundMusicVolume(0.08), { volume: 0.08, defaulted: false })
  assert.deepEqual(resolveBackgroundMusicVolume(0.03), { volume: 0.03, defaulted: false })
  assert.deepEqual(resolveBackgroundMusicVolume(0), { volume: 0, defaulted: false }, '0 is a real choice (music muted)')
  assert.deepEqual(resolveBackgroundMusicVolume('0.5'), { volume: 0.5, defaulted: false })
})
