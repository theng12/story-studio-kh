/**
 * Refinanced EP0018/EP0020 (2026-11-07). The re-mix guard compared `duration_sec − closing_tail_sec`
 * against the original track's WHOLE duration. `duration_sec` is narration + the file's own lead-in +
 * the closing tail, so a head that moved by the current preset's 6 s was reported as 6 s of narration
 * drift — the production numbers (1110 vs 1104, 1080.3 vs 1074.3) named the wrong thing.
 *
 * The production base records are schema v1 with no opening; their durations equal the chapter
 * sidecar's narration extent (1074.273 s of chapters + gaps for EP0020, 1074.267 s in the record), so
 * their head is 0. These cases use those measured facts. Pure arithmetic: no FFmpeg, no paid calls.
 *
 * The 2026-11-04 EP0020 job log (`82ada15c`) is the exact evidence for the red side: it wrote a
 * 1105.3 s re-mix (1074.3 narration + the preset's 6 s head + 25 s tail) and the old guard reported
 * "1080.3 s instead of 1074.3 s". The original completion record, chapter sidecar and merged file are
 * not on this Mac, so the plan-level proof uses the same-shaped facts and the full-path suite
 * (`closing-tail-remix.test.ts`: original 0 s against a current 6 s preset).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { remixProblems } from '../services/closing-tail-remix.js'
import { introLeadInFrom } from '../lib/intro-lead-in.js'

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

test('legacy chapter timing measures the original head and preserves it through the narration guard', () => {
  // Representative sections preserve the logged total; the original chapter files are unavailable.
  const sections = Array.from({ length: 10 }, () => ({ duration_s: 106.5273 }))
  for (const headSec of [0, 6]) {
    const originalDuration = EP0020_NARRATION_SEC + headSec
    const measured = introLeadInFrom(originalDuration, sections, 1)
    assert.equal(measured.status, 'measured')
    assert.ok(Math.abs(measured.seconds - headSec) < 0.01, JSON.stringify(measured))
    const original = { ...track(measured.seconds), durationSec: originalDuration }
    assert.deepEqual(remixProblems({
      duration_sec: originalDuration + TAIL_SEC,
      closing_tail_sec: TAIL_SEC,
      opening: { lead_in_sec: measured.seconds },
    }, original, TAIL_SEC), [], `a measured ${headSec} s opening must preserve narration`)
  }
})
