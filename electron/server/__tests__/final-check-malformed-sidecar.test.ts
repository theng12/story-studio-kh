/**
 * Regression for a surviving completion-review finding — 2026-10-19.
 *
 * FINDING (lower priority, robustness): a malformed final-check sidecar crashes the readers, or
 * is reported as PASS.
 *
 * `readStoredFinalCheck` (electron/server/lib/final-video-check.ts:446-460) validates only that
 * the parsed JSON is an object and that `issues` is an array (line 453). It never checks that
 * `passed` is a boolean, nor that `passed` agrees with `issues.length`, nor that each issue is an
 * object carrying a `verdict`. So a sidecar whose `passed` is false while `issues` is EMPTY, or
 * whose first issue is null, is returned as if it were a verdict.
 *
 * `finalCheckSummary` (line 481-486) then evaluates `stored.result.issues[0]!.verdict` (line 485)
 * and `finalCheckVerdict` (line 470-478) evaluates `first!.verdict` (line 476) on an undefined
 * element — a TypeError. A missing `passed` is falsy, so it takes the same path.
 *
 * Conversely `passed: true` with a non-empty `issues` array is reported as PASS (lines 473 and
 * 484) even though the sidecar itself lists a problem.
 *
 * CONSEQUENCE: the read is NOT wrapped per row. routes/youtube-upload-center.ts reads the stored
 * verdict at line 682 and summarises it at line 793, both inside the `Promise.all(...map(...))`
 * sweep of GET /projects/:slug/youtube/publishable (route at line 596, sweep at line 665). There
 * is no per-row try/catch around those calls, so ONE such sidecar rejects the whole sweep and the
 * route's outer catch (lines 832-833) answers the Publish listing with a 500 for every episode.
 * That contradicts the in-code contract at lines 700-707 ("a listing endpoint must degrade per
 * row, never collectively"). The upload POST gate calls `finalCheckVerdict` at line 2683 and
 * throws the same way.
 *
 * TRIGGER HONESTY: no production writer emits these shapes — `storeFinalCheck` (lines 395-397)
 * serialises exactly what `runFinalCheck` produced, and that sets `passed: issues.length === 0`
 * (line 379). A truncated/partial write is safe (JSON.parse fails -> null). The shapes below are
 * reachable only from a corrupt or hand-edited `<final>.finalcheck.json`, or a foreign writer.
 * This is a robustness gap in a reader whose own docstring promises malformed input is tolerated
 * (lines 443-444), not a normal-flow data bug.
 *
 * CONTROLS: the well-formed fixtures are full `FinalCheckResult` objects (checked_at, file,
 * expected, actual, passed, issues), carrying realistic positive measurements (60 s duration,
 * 60 s video/audio, 1920x1080) and bound to the real file's size/mtime so they are not stale.
 * A future reader that validates the whole shape can reject the malformed fixtures below without
 * any control failing.
 *
 * PLACEMENT: this file uses the application's own relative imports, so it must be copied to
 * electron/server/__tests__/ (the backend runner discovers only electron/server/__tests__/
 * *.test.ts) before it is executed against a release worktree. Importing from anywhere else
 * would silently test the wrong tree.
 *
 * EXPECTED on the current source (3e998778, 1.4.331): the four RED cases below FAIL — the three
 * crash shapes throw, and the passed:true-with-issues shape is summarised as "passed". The four
 * controls pass. All eight pass once the reader rejects the inconsistent shape the way it already
 * rejects a non-array `issues`. Fixtures are left on disk (no cleanup) so a failing run can be
 * inspected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  finalCheckPath,
  finalCheckSummary,
  finalCheckVerdict,
  readStoredFinalCheck,
} from '../lib/final-video-check.js'
import type { FinalCheckIssue, FinalCheckResult } from '../lib/final-video-check.js'

/**
 * A full, well-formed verdict. `fixture` replaces `file` with the real file's size/mtime, so the
 * control reads as current rather than stale. Kept complete on purpose: a stricter reader must
 * still accept it.
 */
function validResult(): FinalCheckResult {
  return {
    checked_at: '2026-10-19T00:00:00.000Z',
    file: { size: 8, mtime_ms: 0 },
    expected: {
      planned_sec: 0,
      tail: { sec: 0, from_end_sec: 0 },
      closing_music: false,
      width: 1920,
      height: 1080,
      subtitles_path: null,
    },
    actual: {
      duration_sec: 60,
      video_sec: 60,
      audio_sec: 60,
      width: 1920,
      height: 1080,
      tail_lufs: null,
      black: [],
      silence: [],
    },
    passed: true,
    issues: [],
  }
}

function issue(check: FinalCheckIssue['check'], verdict: string): FinalCheckIssue {
  return { check, verdict }
}

/** A real (tiny) final file, so the sidecar's identity can be bound to it. */
async function makeVideo(): Promise<{ video: string; size: number; mtime_ms: number }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalcheck-regression-'))
  const video = path.join(dir, 'EP0001_final_video.mp4')
  await fs.writeFile(video, Buffer.alloc(8))
  const stat = await fs.stat(video)
  return { video, size: stat.size, mtime_ms: stat.mtimeMs }
}

/**
 * Write a sidecar from a full valid result, then apply `mutate`. The identity always matches the
 * real file, so staleness cannot mask the passed/issues inconsistency under test.
 */
async function fixture(mutate: (result: FinalCheckResult) => void = () => {}): Promise<string> {
  const { video, size, mtime_ms } = await makeVideo()
  const result = validResult()
  result.file = { size, mtime_ms }
  mutate(result)
  await fs.writeFile(finalCheckPath(video), JSON.stringify(result))
  return video
}

async function corruptSidecar(): Promise<string> {
  const { video } = await makeVideo()
  await fs.writeFile(finalCheckPath(video), '{"passed":true,"issues":[')
  return video
}

/**
 * The contract for every malformed shape: neither reader throws, and neither ever reports PASS.
 * Fix-agnostic — a reader that rejects the shape to null ("not run yet") satisfies it just as a
 * reader that tolerates it with a fail-closed sentence would.
 */
async function assertMalformedSafe(video: string, label: string): Promise<void> {
  const stored = await readStoredFinalCheck(video)
  let summary = ''
  let verdict: string | null = null
  assert.doesNotThrow(() => { summary = finalCheckSummary(stored) }, `${label}: finalCheckSummary must not throw`)
  assert.doesNotThrow(() => { verdict = finalCheckVerdict(stored) }, `${label}: finalCheckVerdict must not throw`)
  assert.ok(verdict === null || typeof verdict === 'string', `${label}: finalCheckVerdict must return string | null`)
  assert.notEqual(summary, 'Final check: passed', `${label}: a malformed sidecar must never be summarised as passed`)
}

// --- controls: a full well-formed sidecar must keep working -----------------

test('control: a well-formed PASS sidecar reads as passed', async () => {
  const video = await fixture()
  const stored = await readStoredFinalCheck(video)
  assert.ok(stored, 'a well-formed sidecar must be read')
  assert.equal(stored!.stale, false)
  assert.equal(finalCheckVerdict(stored), null)
  assert.equal(finalCheckSummary(stored), 'Final check: passed')
})

test('control: a well-formed FAIL sidecar reports its first problem', async () => {
  const video = await fixture((result) => {
    result.passed = false
    result.issues = [issue('silence', 'a silent stretch')]
  })
  const stored = await readStoredFinalCheck(video)
  assert.ok(stored, 'a well-formed sidecar must be read')
  assert.equal(stored!.stale, false)
  assert.equal(finalCheckVerdict(stored), 'a silent stretch')
  assert.match(finalCheckSummary(stored), /1 problem — a silent stretch/)
})

test('control: a corrupt sidecar reads as null, never as a guess', async () => {
  const video = await corruptSidecar()
  assert.equal(await readStoredFinalCheck(video), null,
    'unparseable JSON must read as not checked, not throw')
})

test('control: a missing passed boolean with a listed problem stays fail-closed', async () => {
  // No boolean `passed`, but a real issue. Today this does NOT crash (it returns the issue), and
  // it is already not reported as passed. Pinned as a control, not as a red case.
  const video = await fixture((result) => {
    delete (result as { passed?: boolean }).passed
    result.issues = [issue('silence', 'a silent stretch')]
  })
  await assertMalformedSafe(video, 'missing passed + issue')
})

// --- RED cases: shapes that throw today ------------------------------------

test('RED: passed:false with an EMPTY issues array must not crash the readers', async () => {
  const video = await fixture((result) => {
    result.passed = false
    result.issues = []
  })
  await assertMalformedSafe(video, 'passed:false + empty issues')
})

test('RED: a null first issue must not crash the readers', async () => {
  const video = await fixture((result) => {
    result.passed = false
    result.issues = [null as unknown as FinalCheckIssue]
  })
  await assertMalformedSafe(video, 'null first issue')
})

test('RED: a missing passed boolean with an EMPTY issues array must not crash the readers', async () => {
  const video = await fixture((result) => {
    delete (result as { passed?: boolean }).passed
  })
  await assertMalformedSafe(video, 'missing passed + empty issues')
})

// --- contract: a malformed shape can never be reported as PASS -------------

test('RED/contract: passed:true with problems listed must never be reported as PASS', async () => {
  const video = await fixture((result) => {
    result.passed = true
    result.issues = [issue('silence', 'a silent stretch')]
  })
  await assertMalformedSafe(video, 'passed:true + issue')
})
