/**
 * Refinanced EP0018/EP0020 (2026-11-07). The re-mix guard compared `duration_sec − closing_tail_sec`
 * against the original track's WHOLE duration. `duration_sec` is narration + the file's own lead-in +
 * the closing tail, so a head that moved by the current preset's 6 s was reported as 6 s of narration
 * drift — the production numbers (1110 vs 1104, 1080.3 vs 1074.3) named the wrong thing.
 *
 * The production base records are schema v1 with no opening; their durations equal the chapter
 * sidecar's narration extent (1074.273 s of chapters + gaps for EP0020, 1074.267 s in the record), so
 * their head is 0. These cases use those measured facts. Pure arithmetic: no FFmpeg, no paid calls.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { remixProblems } from '../services/closing-tail-remix.js'

const TAIL_SEC = 25
/** EP0020: 10 chapters + 9 × 1 s gaps = 1074.273 s of narration; the original merge ran 1074.267 s. */
const EP0020_NARRATION_SEC = 1074.267

const track = (leadInSec: number | null) => ({
  dir: '', code: 'EP0020', filename: 'EP0020_merged_audio.mp3', episodeDir: '',
  recordText: '', durationSec: EP0020_NARRATION_SEC, leadInSec,
} as any)

const remix = (opts: { narrationSec?: number; headSec?: number | null }) => {
  const head = opts.headSec ?? 0
  return {
    duration_sec: (opts.narrationSec ?? EP0020_NARRATION_SEC) + head + TAIL_SEC,
    closing_tail_sec: TAIL_SEC,
    opening: opts.headSec === null ? {} : { lead_in_sec: head },
  }
}

test('a head that moved 6 s is a lead-in problem, not 6 s of narration drift', () => {
  // The current preset's 6 s lead-in leaked into the re-mix: 1074.267 narration + 6 head + 25 tail.
  const problems = remixProblems(remix({ headSec: 6 }), track(0), TAIL_SEC)
  assert.ok(problems.some(p => /lead-in came out 6\.00 s instead of 0\.00 s/.test(p)), JSON.stringify(problems))
  assert.ok(!problems.some(p => /narration came out/.test(p)), 'the narration did not move; do not blame it')
})

test('a real narration change is still reported as narration', () => {
  const problems = remixProblems(remix({ narrationSec: EP0020_NARRATION_SEC + 6 }), track(0), TAIL_SEC)
  assert.ok(problems.some(p => /narration came out 1080\.3 s instead of 1074\.3 s/.test(p)), JSON.stringify(problems))
})

test('the same narration and head is no problem at all', () => {
  assert.deepEqual(remixProblems(remix({}), track(0), TAIL_SEC), [])
})

test('a missing original head is missing evidence, never a pass', () => {
  const problems = remixProblems(remix({}), track(null), TAIL_SEC)
  assert.ok(problems.some(p => /original record does not say how long its lead-in is/.test(p)), JSON.stringify(problems))
})

test('a missing new head is missing evidence too', () => {
  const problems = remixProblems(remix({ headSec: null }), track(0), TAIL_SEC)
  assert.ok(problems.some(p => /does not say how long its narration is/.test(p)), JSON.stringify(problems))
})
