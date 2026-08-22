/**
 * v1.4.22 — a caption check must not answer for a file that has since changed.
 *
 * WHAT HAPPENED. The owner opened the caption check on EP0051, saw captions
 * that did not match the narration playing under them, and told me he would
 * re-transcribe. The transcript was already correct: the panel was showing a
 * result from before his last re-stitch. Measured at the time —
 * `EP0051_stitched.corrected.srt` written 14:23, `EP0051_stitched.srt` written
 * 14:32, and the run he was reading predated both. A fresh run returned
 * captions that matched the file exactly.
 *
 * That is the worst failure this panel can have. It exists to be the thing you
 * trust before committing to a render, so evidence about an older file is not
 * merely useless — it actively sends you to fix something that is not broken.
 *
 * The frames themselves were never wrong. What was missing was any way to know
 * WHICH version of the file they described, which is what the fingerprint adds.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** The comparison the page makes. Kept in one place so both sides agree. */
function isStale(
  known: { mtime_ms: number; size: number } | null | undefined,
  now: { mtime_ms: number; size: number } | null | undefined,
): boolean {
  if (!known) return false           // nothing to compare — do not cry wolf
  if (!now) return true              // deleted is a change
  return now.mtime_ms !== known.mtime_ms || now.size !== known.size
}

describe('knowing whether a caption check is still about the current file', () => {
  test('a rewritten subtitle file is detected as a change', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssk-preflight-fresh-'))
    const srt = path.join(dir, 'EP0051_stitched.corrected.srt')
    await fs.writeFile(srt, '1\n00:00:16,066 --> 00:00:23,346\nOriginal line.\n')
    const before = await fs.stat(srt)
    const known = { mtime_ms: Math.round(before.mtimeMs), size: before.size }

    // A re-stitch: same name, different content — exactly the EP0051 case.
    await fs.writeFile(srt, '1\n00:00:16,066 --> 00:00:23,346\nA corrected and noticeably longer line.\n')
    const after = await fs.stat(srt)
    assert.ok(isStale(known, { mtime_ms: Math.round(after.mtimeMs), size: after.size }),
      'a rewritten subtitle file must invalidate the check that described the old one')

    await fs.rm(dir, { recursive: true, force: true })
  })

  test('an untouched file is not reported stale', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssk-preflight-fresh-'))
    const srt = path.join(dir, 'x.srt')
    await fs.writeFile(srt, 'unchanged')
    const st = await fs.stat(srt)
    const fp = { mtime_ms: Math.round(st.mtimeMs), size: st.size }
    assert.equal(isStale(fp, fp), false,
      'crying wolf on an unchanged file would train the owner to ignore the warning')
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('a deleted burn target counts as a change', () => {
    assert.equal(isStale({ mtime_ms: 1, size: 2 }, null), true)
  })

  test('an unknown fingerprint never invalidates a good result', () => {
    // Older stored results carry no fingerprint. They must keep working rather
    // than permanently show a warning nobody can clear.
    assert.equal(isStale(null, { mtime_ms: 1, size: 2 }), false)
    assert.equal(isStale(undefined, undefined), false)
  })

  test('a same-size edit is still caught, because the timestamp moves', async () => {
    // Size alone would miss a correction that swaps one word for another of
    // the same length — which is exactly what a spelling correction pass does.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssk-preflight-fresh-'))
    const srt = path.join(dir, 'y.srt')
    await fs.writeFile(srt, 'Basrah')
    const a = await fs.stat(srt)
    await new Promise(r => setTimeout(r, 12))
    await fs.writeFile(srt, 'Basraa')
    const b = await fs.stat(srt)
    assert.equal(a.size, b.size, 'fixture must keep the size identical')
    assert.ok(isStale(
      { mtime_ms: Math.round(a.mtimeMs), size: a.size },
      { mtime_ms: Math.round(b.mtimeMs), size: b.size },
    ), 'a same-length correction must still invalidate the check')
    await fs.rm(dir, { recursive: true, force: true })
  })
})
