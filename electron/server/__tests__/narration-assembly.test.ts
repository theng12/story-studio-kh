/**
 * Tests for the per-chapter narration assembly pipeline.
 *
 * What this pins:
 *   - splitNarrationIntoChapters parses the bulk LLM output (the exact
 *     shape narrationPrompt instructs the model to emit) into intro +
 *     chapters with titles preserved.
 *   - writeChapterFiles + assembleUnifiedNarration round-trip cleanly:
 *     the unified docx that downstream readers (audio reconciler,
 *     subtitles, video assembly, story-context readers) consume comes
 *     back from parseNarrationDocx as Introduction first, then chapters
 *     in numeric order with the right slugs.
 *   - Re-assembling is idempotent: assemble → parse → assemble →
 *     parse produces the same section list (no duplicates, no drift).
 *   - ensureChapterFilesMigrated materialises chapter files from a legacy
 *     unified-only narration, and is a no-op on the second call.
 *
 * These invariants are load-bearing for the audio pipeline: the slug
 * exactness (`Introduction`, `Chapter_01`, `Chapter_02`) is what
 * audio-reconciler uses to name chunk files. A regression here would
 * silently rename `{CODE}_Chapter_03.mp3` → something else.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  splitNarrationIntoChapters,
  writeChapterFiles,
  assembleUnifiedNarration,
  ensureChapterFilesMigrated,
  chapterFilePath,
  introductionFilePath,
} from '../lib/narration-assembly.js'
import { buildNarrationDocx } from '../lib/docx-builder.js'
import { parseNarrationDocx } from '../lib/docx-parser.js'

let tmpRoot: string

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'narration-assembly-test-'))
})

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

// Bulk-output fixture mirroring the format `narrationPrompt` instructs
// the LLM to produce. Real outputs vary in spacing, so we throw a few
// quirks in to stress the parser.
const BULK_WITH_INTRO = `# Introduction (~350 words)

Welcome back to the show. Tonight we drift toward a quiet shore.

The breeze is gentle.

# The Tidal Sojourn — Narration

## Chapter 01: The Mist-Kissed Shore

On a remote Scottish isle, the morning mist lay draped like a gentle veil.

The sea breathed softly against the rocks.

## Chapter 02: The Selkie Weaver

Far beyond the dunes, a weaver crafted cloaks from the deep currents.

She longed for the touch of earthbound dreams.

## Chapter 03: The Tide That Listened

The waves remembered her name long after she had forgotten it.
`

const BULK_NO_INTRO = `# The Tidal Sojourn — Narration

## Chapter 01: The Mist-Kissed Shore

Body of chapter one.

## Chapter 02: The Selkie Weaver

Body of chapter two.
`

describe('splitNarrationIntoChapters', () => {
  test('parses intro + chapters from a bulk LLM output', () => {
    const parts = splitNarrationIntoChapters(BULK_WITH_INTRO)
    assert.ok(parts.intro, 'intro must be parsed when "# Introduction" heading present')
    assert.match(parts.intro!.text, /Welcome back to the show/)
    assert.equal(parts.chapters.length, 3)
    assert.deepEqual(parts.chapters.map(c => c.number), [1, 2, 3])
    assert.equal(parts.chapters[0]!.title, 'The Mist-Kissed Shore')
    assert.equal(parts.chapters[1]!.title, 'The Selkie Weaver')
    assert.match(parts.chapters[0]!.text, /morning mist/)
  })

  test('handles no-intro case', () => {
    const parts = splitNarrationIntoChapters(BULK_NO_INTRO)
    assert.equal(parts.intro, undefined, 'no intro section emitted when absent')
    assert.equal(parts.chapters.length, 2)
    assert.equal(parts.chapters[1]!.title, 'The Selkie Weaver')
  })

  test('matches "# Intro" shorthand and ignores trailing parenthetical', () => {
    const text = `# Intro\n\nQuick welcome.\n\n## Chapter 01: A\n\nText.`
    const parts = splitNarrationIntoChapters(text)
    assert.ok(parts.intro)
    assert.match(parts.intro!.text, /Quick welcome/)
    assert.equal(parts.chapters.length, 1)
  })

  test('handles all common chapter title separators', () => {
    const text = [
      '## Chapter 01: Colon Title',
      'Body 1.',
      '## Chapter 02 - Hyphen Title',
      'Body 2.',
      '## Chapter 03 – En Dash Title',
      'Body 3.',
      '## Chapter 04 — Em Dash Title',
      'Body 4.',
    ].join('\n\n')
    const parts = splitNarrationIntoChapters(text)
    assert.deepEqual(
      parts.chapters.map(c => c.title),
      ['Colon Title', 'Hyphen Title', 'En Dash Title', 'Em Dash Title'],
    )
  })

  test('skips title-card / preamble lines before the first heading', () => {
    const text = [
      'Title goes here',
      'Subtitle italic',
      '',
      '# Introduction',
      'Real intro starts here.',
      '',
      '## Chapter 01: First',
      'Real chapter starts here.',
    ].join('\n')
    const parts = splitNarrationIntoChapters(text)
    assert.match(parts.intro!.text, /Real intro starts here/)
    assert.ok(!parts.intro!.text.includes('Subtitle italic'), 'preamble must not leak into intro')
    assert.match(parts.chapters[0]!.text, /Real chapter starts here/)
  })
})

describe('writeChapterFiles + assembleUnifiedNarration round-trip', () => {
  test('chapters-only round-trip: parsed sections match the original section list', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'roundtrip-'))
    const code = 'TST0001'
    const title = 'The Tidal Sojourn'

    const parts = splitNarrationIntoChapters(BULK_NO_INTRO)
    await writeChapterFiles(dir, code, title, parts)

    // Per-chapter files materialised
    assert.ok(existsSync(chapterFilePath(dir, code, 1)), 'Chapter_01.docx written')
    assert.ok(existsSync(chapterFilePath(dir, code, 2)), 'Chapter_02.docx written')
    assert.ok(!existsSync(introductionFilePath(dir, code)), 'no intro file when intro absent')

    // Unified assembly
    const result = await assembleUnifiedNarration(dir, code, title)
    assert.deepEqual(result.chapter_numbers, [1, 2])
    assert.equal(result.introduction_present, false)

    // Re-parse the unified output: must yield Chapter_01 + Chapter_02 in order.
    const unifiedPath = path.join(dir, `${code}_Script_Narration.docx`)
    const sections = await parseNarrationDocx(unifiedPath)
    const slugs = sections.map(s => s.slug)
    assert.deepEqual(slugs, ['Chapter_01', 'Chapter_02'])
    assert.match(sections[0]!.text, /chapter one/)
    assert.match(sections[1]!.text, /chapter two/)
  })

  test('intro + chapters: Introduction is the FIRST parsed section', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'roundtrip-intro-'))
    const code = 'TST0002'
    const title = 'The Tidal Sojourn'

    await writeChapterFiles(dir, code, title, splitNarrationIntoChapters(BULK_WITH_INTRO))
    const result = await assembleUnifiedNarration(dir, code, title)
    assert.equal(result.introduction_present, true)
    assert.deepEqual(result.chapter_numbers, [1, 2, 3])

    const sections = await parseNarrationDocx(path.join(dir, `${code}_Script_Narration.docx`))
    // CRITICAL: audio-reconciler uses sections[0].slug to build chunk
    // filenames. If Introduction isn't slug-exact and first, the audio
    // pipeline silently produces wrong filenames.
    assert.equal(sections[0]!.slug, 'Introduction')
    assert.deepEqual(
      sections.map(s => s.slug),
      ['Introduction', 'Chapter_01', 'Chapter_02', 'Chapter_03'],
    )
  })

  test('round-trip is idempotent: assemble → parse → assemble produces identical sections', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'roundtrip-idem-'))
    const code = 'TST0003'
    const title = 'X'

    await writeChapterFiles(dir, code, title, splitNarrationIntoChapters(BULK_WITH_INTRO))
    await assembleUnifiedNarration(dir, code, title)
    const firstSlugs = (await parseNarrationDocx(path.join(dir, `${code}_Script_Narration.docx`))).map(s => s.slug)

    // Re-assemble without changing anything on disk. Slugs must be stable.
    await assembleUnifiedNarration(dir, code, title)
    const secondSlugs = (await parseNarrationDocx(path.join(dir, `${code}_Script_Narration.docx`))).map(s => s.slug)
    assert.deepEqual(secondSlugs, firstSlugs, 'slug list must be stable across re-assemblies')
  })

  test('overwrite-in-place: rewriting one chapter only replaces that chapter', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'roundtrip-overwrite-'))
    const code = 'TST0004'
    const title = 'X'

    await writeChapterFiles(dir, code, title, splitNarrationIntoChapters(BULK_NO_INTRO))
    await assembleUnifiedNarration(dir, code, title)

    // Simulate a chapter-only regenerate: overwrite Chapter_02 with new
    // content, leave Chapter_01 alone, re-assemble.
    await writeChapterFiles(dir, code, title, {
      chapters: [{ number: 2, title: 'The Selkie Weaver (revised)', text: 'New body for chapter two.' }],
    })
    await assembleUnifiedNarration(dir, code, title)

    const sections = await parseNarrationDocx(path.join(dir, `${code}_Script_Narration.docx`))
    assert.deepEqual(sections.map(s => s.slug), ['Chapter_01', 'Chapter_02'], 'chapter list unchanged')
    assert.match(sections[0]!.text, /chapter one/, 'Chapter 01 untouched')
    assert.match(sections[1]!.text, /New body for chapter two/, 'Chapter 02 replaced')
  })

  test('empty scriptDir → assemble returns empty result without writing', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'roundtrip-empty-'))
    const code = 'TST0005'
    const result = await assembleUnifiedNarration(dir, code, 'X')
    assert.deepEqual(result, { chapter_numbers: [], introduction_present: false })
    assert.ok(!existsSync(path.join(dir, `${code}_Script_Narration.docx`)), 'no unified file when nothing to assemble')
  })
})

describe('ensureChapterFilesMigrated', () => {
  test('materialises chapter files from a legacy unified-only narration', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'migrate-'))
    const code = 'TST0006'
    const title = 'Legacy'

    // Lay down a legacy unified narration with no per-chapter files.
    await buildNarrationDocx(BULK_WITH_INTRO, code, title, path.join(dir, `${code}_Script_Narration.docx`))
    assert.ok(!existsSync(chapterFilePath(dir, code, 1)), 'precondition: no chapter files yet')

    const ran = await ensureChapterFilesMigrated(dir, code, title)
    assert.equal(ran, true, 'migration must run on first call')
    assert.ok(existsSync(chapterFilePath(dir, code, 1)), 'Chapter_01.docx materialised')
    assert.ok(existsSync(chapterFilePath(dir, code, 2)), 'Chapter_02.docx materialised')
    assert.ok(existsSync(chapterFilePath(dir, code, 3)), 'Chapter_03.docx materialised')
    assert.ok(existsSync(introductionFilePath(dir, code)), 'Introduction.docx materialised')
  })

  test('idempotent: second call is a no-op', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'migrate-idem-'))
    const code = 'TST0007'
    const title = 'Legacy'

    await buildNarrationDocx(BULK_NO_INTRO, code, title, path.join(dir, `${code}_Script_Narration.docx`))
    await ensureChapterFilesMigrated(dir, code, title)
    const firstRan = await ensureChapterFilesMigrated(dir, code, title)
    // First migration ran; the SECOND call must be a no-op.
    assert.equal(firstRan, false, 'second call returns false (no-op)')
  })

  test('no-op when no unified file exists', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'migrate-empty-'))
    const ran = await ensureChapterFilesMigrated(dir, 'TST0008', 'X')
    assert.equal(ran, false, 'no source → no migration')
  })
})
