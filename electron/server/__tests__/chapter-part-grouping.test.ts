/**
 * v1.0.224 — multi-part chapter grouping (audio-merge ↔ subtitles ↔ stitch).
 *
 * A long chapter is split by the TTS char cap into `{code}_{slug}_part{N}.mp3`
 * files. The merge must group those parts back under one chapter key so:
 *   - silence gaps go only BETWEEN chapters (not between parts), and
 *   - audio_chapters.json carries one section per chapter (summed duration),
 * which is what the per-chapter SRTs (and the stitcher) expect.
 *
 * `chapterKeyOf` is the grouping primitive; it must agree with the per-chapter
 * SRT slug derivation in generators/subtitles.ts.
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

let chapterKeyOf: (filename: string, code: string) => string
let compareChapterFilenames: (a: string, b: string) => number
let isActiveChapterAudioFilename: (filename: string) => boolean

before(async () => {
  ;({ chapterKeyOf, compareChapterFilenames, isActiveChapterAudioFilename } = await import('../generators/audio-merge.js'))
})

describe('chapterKeyOf — collapse part/version suffixes to the chapter slug', () => {
  const code = 'EP0001'
  test('strips the code prefix', () => {
    assert.equal(chapterKeyOf('EP0001_Chapter_01.mp3', code), 'Chapter_01')
  })
  test('groups _part1/_part2 of the same chapter under one key', () => {
    assert.equal(chapterKeyOf('EP0001_Chapter_01_part1.mp3', code), 'Chapter_01')
    assert.equal(chapterKeyOf('EP0001_Chapter_01_part2.mp3', code), 'Chapter_01')
  })
  test('handles the versioned + part combo (matches subtitle grouping)', () => {
    assert.equal(chapterKeyOf('EP0001_Chapter_01_part2_v3.mp3', code), 'Chapter_01')
    assert.equal(chapterKeyOf('EP0001_Chapter_01_v2.mp3', code), 'Chapter_01')
  })
  test('strips the tempdir _normalized marker', () => {
    assert.equal(chapterKeyOf('EP0001_Chapter_01_part1_normalized.mp3', code), 'Chapter_01')
  })
  test('leaves single-chunk Introduction intact', () => {
    assert.equal(chapterKeyOf('EP0001_Introduction.mp3', code), 'Introduction')
  })
  test('two parts collapse to the same key (the grouping invariant)', () => {
    const a = chapterKeyOf('EP0001_Chapter_03_part1.mp3', code)
    const b = chapterKeyOf('EP0001_Chapter_03_part2.mp3', code)
    assert.equal(a, b)
    assert.equal(a, 'Chapter_03')
  })
})

test('recognizes only the base chapter audio as active for Audio Assembly', () => {
  assert.equal(isActiveChapterAudioFilename('EP0001_Chapter_01.mp3'), true)
  assert.equal(isActiveChapterAudioFilename('EP0001_Chapter_01_part2.mp3'), true)
  assert.equal(isActiveChapterAudioFilename('EP0001_Chapter_01_v2.mp3'), false)
  assert.equal(isActiveChapterAudioFilename('EP0001_Chapter_01_part2_v3.mp3'), false)
})

describe('compareChapterFilenames — natural sort for the Audio Assembly list', () => {
  function sort(input: string[]): string[] {
    return [...input].sort(compareChapterFilenames)
  }

  test('Introduction comes before any chapter', () => {
    assert.deepEqual(
      sort(['TN0001_Chapter_01.mp3', 'TN0001_Introduction.mp3']),
      ['TN0001_Introduction.mp3', 'TN0001_Chapter_01.mp3'],
    )
  })

  test('chapters sort numerically (Chapter_02 before Chapter_10)', () => {
    assert.deepEqual(
      sort(['TN0001_Chapter_10.mp3', 'TN0001_Chapter_02.mp3', 'TN0001_Chapter_01.mp3']),
      ['TN0001_Chapter_01.mp3', 'TN0001_Chapter_02.mp3', 'TN0001_Chapter_10.mp3'],
    )
  })

  // The bug the user reported on TN0153: part10 was sorting between part1 and
  // part2 because the old comparator returned 0 for same-chapter pairs and the
  // sort fell through to readdir order (lexical).
  test('parts of the same chapter sort numerically (part2 before part10)', () => {
    const messy = [
      'TN0153_Chapter_04_part1.mp3',
      'TN0153_Chapter_04_part10.mp3',
      'TN0153_Chapter_04_part11.mp3',
      'TN0153_Chapter_04_part2.mp3',
      'TN0153_Chapter_04_part20.mp3',
      'TN0153_Chapter_04_part3.mp3',
    ]
    assert.deepEqual(sort(messy), [
      'TN0153_Chapter_04_part1.mp3',
      'TN0153_Chapter_04_part2.mp3',
      'TN0153_Chapter_04_part3.mp3',
      'TN0153_Chapter_04_part10.mp3',
      'TN0153_Chapter_04_part11.mp3',
      'TN0153_Chapter_04_part20.mp3',
    ])
  })

  test('a bare chapter file sorts BEFORE its _partN files (same chapter)', () => {
    assert.deepEqual(
      sort(['TN0153_Chapter_04_part1.mp3', 'TN0153_Chapter_04.mp3']),
      ['TN0153_Chapter_04.mp3', 'TN0153_Chapter_04_part1.mp3'],
    )
  })

  test('full TN0153 episode shape (Intro + chapters 1-3 + Chapter 04 with 23 parts) sorts cleanly', () => {
    const input = [
      'TN0153_Chapter_04_part10.mp3',
      'TN0153_Chapter_04_part1.mp3',
      'TN0153_Chapter_04_part2.mp3',
      'TN0153_Chapter_04_part23.mp3',
      'TN0153_Chapter_04_part3.mp3',
      'TN0153_Chapter_01.mp3',
      'TN0153_Chapter_03.mp3',
      'TN0153_Chapter_04.mp3',
      'TN0153_Introduction.mp3',
      'TN0153_Chapter_02.mp3',
    ]
    const out = sort(input)
    // Introduction → Chapter_01..03 → bare Chapter_04 → parts 1,2,3,…,10,…,23.
    assert.equal(out[0], 'TN0153_Introduction.mp3')
    assert.equal(out[1], 'TN0153_Chapter_01.mp3')
    assert.equal(out[2], 'TN0153_Chapter_02.mp3')
    assert.equal(out[3], 'TN0153_Chapter_03.mp3')
    assert.equal(out[4], 'TN0153_Chapter_04.mp3')
    assert.equal(out[5], 'TN0153_Chapter_04_part1.mp3')
    assert.equal(out[6], 'TN0153_Chapter_04_part2.mp3')
    assert.equal(out[7], 'TN0153_Chapter_04_part3.mp3')
    assert.equal(out[8], 'TN0153_Chapter_04_part10.mp3')
    assert.equal(out[9], 'TN0153_Chapter_04_part23.mp3')
  })

  test('non-chapter, non-intro files do not interleave with the chapter run', () => {
    // Defensive: an unrelated mp3 (e.g. a user-imported file) shouldn't slot
    // BETWEEN Chapter_01 and Chapter_02 — it sorts to one end of the chapter
    // block. This preserves the original comparator's semantics (a file with
    // no "chapter" match sorts before any chapter file), which matters less
    // than NOT interleaving — the assembly UI lets the user reorder rows.
    const out = sort([
      'TN0001_Chapter_02.mp3',
      'TN0001_misc.mp3',
      'TN0001_Chapter_01.mp3',
      'TN0001_Introduction.mp3',
    ])
    // Introduction first by the intro rule.
    assert.equal(out[0], 'TN0001_Introduction.mp3')
    // The chapter run stays contiguous and numerically ordered.
    const ch1Idx = out.indexOf('TN0001_Chapter_01.mp3')
    const ch2Idx = out.indexOf('TN0001_Chapter_02.mp3')
    const miscIdx = out.indexOf('TN0001_misc.mp3')
    assert.ok(ch1Idx < ch2Idx, 'Chapter_01 before Chapter_02')
    assert.ok(miscIdx < ch1Idx || miscIdx > ch2Idx, 'misc file does not slot between chapters')
  })
})
