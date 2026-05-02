/**
 * Tests for chapter-timestamp formatting helpers (lib/subtitle-builder.ts).
 *
 * Covers `formatChapterTimestamps` since it's a pure function with
 * non-trivial edge cases:
 *   - YouTube auto-chapter needs ≥ 3 entries → empty string under that
 *   - first line MUST start at 0:00 even if helper computed nonzero
 *   - timestamps switch from M:SS to H:MM:SS past the hour
 *   - missing titles fall back to "Chapter N"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { formatChapterTimestamps, chaptersFromDurations } from '../lib/subtitle-builder.js'

describe('formatChapterTimestamps', () => {
  test('returns empty string for fewer than 3 chapters', () => {
    assert.equal(formatChapterTimestamps([]), '')
    assert.equal(formatChapterTimestamps([
      { title: 'A', start_sec: 0, end_sec: 60 },
    ]), '')
    assert.equal(formatChapterTimestamps([
      { title: 'A', start_sec: 0, end_sec: 60 },
      { title: 'B', start_sec: 60, end_sec: 120 },
    ]), '')
  })

  test('forces first line to 0:00 even if start_sec is nonzero', () => {
    // chaptersFromDurations always returns 0 for the first start, but
    // hand-constructed chapters might not — make sure the formatter
    // forces 0:00 so YouTube auto-detects the block.
    const out = formatChapterTimestamps([
      { title: 'Intro', start_sec: 12, end_sec: 60 },        // nonzero!
      { title: 'Ch 1', start_sec: 60, end_sec: 240 },
      { title: 'Ch 2', start_sec: 240, end_sec: 480 },
    ])
    const firstLine = out.split('\n')[0]
    assert.equal(firstLine, '0:00 Intro', 'first line must be 0:00')
  })

  test('formats under-hour timestamps as M:SS', () => {
    const chapters = chaptersFromDurations([
      { title: 'Intro', duration_sec: 60 },
      { title: 'Chapter 1', duration_sec: 272 },          // 4:32
      { title: 'Chapter 2', duration_sec: 456 },          // 7:36
    ], 0)
    const out = formatChapterTimestamps(chapters)
    assert.equal(out, '0:00 Intro\n1:00 Chapter 1\n5:32 Chapter 2')
  })

  test('switches to H:MM:SS past the hour', () => {
    const chapters = chaptersFromDurations([
      { title: 'Intro', duration_sec: 1800 },             // 30 min
      { title: 'Chapter 1', duration_sec: 2400 },         // 40 min  → cumulative 1:10:00
      { title: 'Chapter 2', duration_sec: 600 },          // 10 min  → cumulative 1:20:00
    ], 0)
    const out = formatChapterTimestamps(chapters)
    const lines = out.split('\n')
    assert.equal(lines[0], '0:00 Intro')
    assert.equal(lines[1], '30:00 Chapter 1')
    assert.equal(lines[2], '1:10:00 Chapter 2')
  })

  test('falls back to "Chapter N" for missing titles', () => {
    const chapters = [
      { title: '', start_sec: 0, end_sec: 60 },
      { title: '', start_sec: 60, end_sec: 120 },
      { title: '', start_sec: 120, end_sec: 180 },
    ]
    const out = formatChapterTimestamps(chapters)
    assert.equal(out, '0:00 Chapter 1\n1:00 Chapter 2\n2:00 Chapter 3')
  })

  test('floors fractional seconds', () => {
    const chapters = [
      { title: 'A', start_sec: 0, end_sec: 60 },
      { title: 'B', start_sec: 60.7, end_sec: 120 },
      { title: 'C', start_sec: 120.999, end_sec: 180 },
    ]
    const out = formatChapterTimestamps(chapters)
    assert.match(out, /1:00 B/)     // 60.7 floored to 60
    assert.match(out, /2:00 C/)     // 120.999 floored to 120
  })
})
