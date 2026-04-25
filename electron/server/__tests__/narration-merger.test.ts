/**
 * Tests for the introduction-into-narration merger pipeline.
 *
 * The merger writes one canonical narration .docx per episode. Splitting
 * intro and chapters into separate files broke audio / subtitles / video
 * (see system audit "PROBLEM" section); this test pins the round-trip
 * so future changes can't silently regress to the broken layout.
 *
 * Round-trip under test:
 *   1. Build a chapters-only narration docx.
 *   2. Convert it back to markdown source via narrationDocxToMarkdown.
 *   3. Splice an "Introduction" block on top.
 *   4. Re-render via buildNarrationDocx — overwriting the same file.
 *   5. Parse the resulting docx with parseNarrationDocx.
 *   6. Assert: Introduction is the FIRST section, chapters preserved
 *      with their titles intact.
 *
 * Also covers `stripIntroFromNarrationMarkdown` so re-running intro
 * generation replaces the prior intro instead of stacking.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { buildNarrationDocx } from '../lib/docx-builder.js'
import {
  parseNarrationDocx,
  narrationDocxToMarkdown,
  stripIntroFromNarrationMarkdown,
} from '../lib/docx-parser.js'

let tmpDir: string

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narration-merger-test-'))
})

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

const CHAPTERS_MARKDOWN = `# The Tidal Sojourn — Narration

## Chapter 01: The Mist-Kissed Shore

On a remote Scottish isle, the morning mist lay draped like a gentle veil.

The sea breathed softly against the rocks.

## Chapter 02: The Selkie Weaver

Far beyond the dunes, a weaver crafted cloaks from the deep currents.

She longed for the touch of earthbound dreams.
`

describe('stripIntroFromNarrationMarkdown', () => {
  test('cuts everything before the first ## Chapter heading', () => {
    const stacked = `# Introduction\n\nWelcome.\n\n# Title — Narration\n\n## Chapter 01: A\n\nText.`
    const stripped = stripIntroFromNarrationMarkdown(stacked)
    assert.ok(stripped.startsWith('## Chapter 01'), 'must start at first chapter')
    assert.ok(!stripped.includes('Introduction'), 'intro block must be gone')
  })

  test('passthrough when there are no chapters yet', () => {
    const noChapters = '# Introduction\n\nWelcome.'
    assert.equal(stripIntroFromNarrationMarkdown(noChapters), noChapters)
  })

  test('idempotent: stripping twice = stripping once', () => {
    const stacked = `# Introduction\n\nWelcome.\n\n## Chapter 01: A\n\nText.`
    const once = stripIntroFromNarrationMarkdown(stacked)
    const twice = stripIntroFromNarrationMarkdown(once)
    assert.equal(once, twice)
  })
})

describe('narration docx round-trip', () => {
  test('chapters-only docx → markdown → docx preserves chapter titles', async () => {
    const docxPath = path.join(tmpDir, 'roundtrip-chapters.docx')
    await buildNarrationDocx(CHAPTERS_MARKDOWN, 'TST0001', 'The Tidal Sojourn', docxPath)

    const markdown = await narrationDocxToMarkdown(docxPath)
    // Chapter headings must survive the round-trip — that's how
    // parseNarrationDocx slices the file into per-chapter audio sections.
    assert.match(markdown, /## Chapter 01: The Mist-Kissed Shore/)
    assert.match(markdown, /## Chapter 02: The Selkie Weaver/)
  })

  test('intro merged into chapters: parser sees Introduction as first section', async () => {
    // Step 1: chapters file on disk
    const docxPath = path.join(tmpDir, 'roundtrip-merged.docx')
    await buildNarrationDocx(CHAPTERS_MARKDOWN, 'TST0002', 'The Tidal Sojourn', docxPath)

    // Step 2-4: simulate generateIntroductionOnly — read chapters, splice
    // intro on top, rewrite same file.
    const existingMarkdown = await narrationDocxToMarkdown(docxPath)
    const chaptersMarkdown = stripIntroFromNarrationMarkdown(existingMarkdown)
    const introText = 'Welcome to the show. Tonight we drift to the shore.'
    const unified = [
      '# Introduction',
      '',
      introText,
      '',
      '# The Tidal Sojourn — Narration',
      '',
      chaptersMarkdown,
    ].join('\n')
    await buildNarrationDocx(unified, 'TST0002', 'The Tidal Sojourn', docxPath)

    // Step 5-6: parser must report Introduction first, chapters after.
    const sections = await parseNarrationDocx(docxPath)
    assert.ok(sections.length >= 3, 'expected intro + 2 chapters')

    const intro = sections.find(s => s.slug === 'Introduction')
    assert.ok(intro, 'Introduction section must be present')
    assert.match(intro!.text, /Welcome to the show/)

    const ch1 = sections.find(s => s.slug === 'Chapter_01')
    const ch2 = sections.find(s => s.slug === 'Chapter_02')
    assert.ok(ch1, 'Chapter_01 preserved after merge')
    assert.ok(ch2, 'Chapter_02 preserved after merge')
    assert.match(ch1!.text, /Mist-Kissed Shore|gentle veil/)
    assert.match(ch2!.text, /weaver|earthbound/i)

    // Critical for audio pipeline: Introduction must be slug 'Introduction'
    // exactly so audio-reconciler emits {CODE}_Introduction.mp3.
    assert.equal(sections[0]?.slug, 'Introduction', 'intro must be the FIRST parsed section')
  })

  test('re-running intro replaces the prior one (no stacking)', async () => {
    const docxPath = path.join(tmpDir, 'roundtrip-rerun.docx')
    await buildNarrationDocx(CHAPTERS_MARKDOWN, 'TST0003', 'X', docxPath)

    // First intro
    const firstUnified = [
      '# Introduction', '', 'First intro.', '',
      '# X — Narration', '',
      stripIntroFromNarrationMarkdown(await narrationDocxToMarkdown(docxPath)),
    ].join('\n')
    await buildNarrationDocx(firstUnified, 'TST0003', 'X', docxPath)

    // Second intro — should REPLACE, not stack
    const secondUnified = [
      '# Introduction', '', 'Second intro.', '',
      '# X — Narration', '',
      stripIntroFromNarrationMarkdown(await narrationDocxToMarkdown(docxPath)),
    ].join('\n')
    await buildNarrationDocx(secondUnified, 'TST0003', 'X', docxPath)

    const sections = await parseNarrationDocx(docxPath)
    const intros = sections.filter(s => s.slug === 'Introduction')
    assert.equal(intros.length, 1, 'must have exactly one Introduction section after re-run')
    assert.match(intros[0]!.text, /Second intro/, 'must contain the LATEST intro')
    assert.ok(!intros[0]!.text.includes('First intro'), 'old intro must be gone')
  })
})
