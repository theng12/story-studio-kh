/**
 * Video Assembly Step 1 must say WHAT is missing.
 *
 * DK0032 sat behind "Not ready — fill in the required inputs first" with a
 * footnote naming "Scene Plan timing, images, and approvals" as one lump. Its
 * images and approvals were 310/310; the real deficit was 257.9s of narration
 * before scene 1 with no scene planned for it. A gate that will not name its
 * own condition is the defect these tests pin.
 *
 * Source-text assertions: the page is a single 6k-line SFC with no component
 * harness in this suite, and the wording IS the fix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'pages/projects/[slug]/video-assembly.vue'),
  'utf-8',
)

test('the lumped footnote is gone', () => {
  assert.doesNotMatch(
    source,
    /Scene Plan timing, images, and approvals must all be complete before rendering/,
  )
})

test('each deficit is measured and named separately', () => {
  assert.match(source, /const unifiedTimingProblems = computed<string\[\]>/)
  // Head, internal, tail and overlap are four different problems with four
  // different remedies; the old copy could not tell them apart.
  assert.match(source, /The first \$\{fmtGap\(t\.head_gap_sec\)\} of narration has no scene/)
  assert.match(source, /t\.gap_count > 0/)
  assert.match(source, /t\.tail_gap_sec > 0/)
  assert.match(source, /t\.overlap_count > 0/)
  // Images/approvals are reported only when they are actually short.
  assert.match(source, /cov\.ready !== cov\.total/)
})

test('every named deficit says where to fix it', () => {
  assert.match(source, /Cover the opening/)
  assert.match(source, /Repair coverage/)
  assert.match(source, /Rebuild the Scene Plan timeline/)
})

test('the gate is never silent about itself', () => {
  // If `complete` is false for a reason none of the measurements explain, the
  // page must still say something rather than show an empty list.
  assert.match(source, /if \(!out\.length\) out\.push\(/)
})

test('the deficit list is what Step 1 renders', () => {
  assert.match(source, /v-for="\(problem, i\) in unifiedTimingProblems"/)
})
