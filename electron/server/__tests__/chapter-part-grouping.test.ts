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

before(async () => {
  ;({ chapterKeyOf } = await import('../generators/audio-merge.js'))
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
