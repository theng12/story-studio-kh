/**
 * SRT timestamp + cue-number shifting (v1.0.71+).
 *
 * When a long-audio file exceeds Whisper's 25 MB cap, we segment with
 * FFmpeg, transcribe each chunk separately, and stitch the SRT cues
 * together with cumulative offsets. The stitching primitive is
 * `shiftSrtTimestamps` — a pure function with no I/O, easy to lock down
 * with unit tests.
 *
 * Without these: a regression that drops a leading zero in the timecode
 * format or skips the cue-index renumbering ships SRT files where chunk
 * 2's first cue is "1" again, or chunk 1's last cue ends at 8:00 and
 * chunk 2's first cue starts at 0:00 (overlap).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { shiftSrtTimestamps } from '../lib/whisper-client.js'

describe('shiftSrtTimestamps', () => {
  test('shifts a single cue forward by a whole-second offset', () => {
    const input = `1
00:00:01,000 --> 00:00:04,250
Hello world.`
    const { srt, cueCount, lastEndSeconds } = shiftSrtTimestamps(input, 480, 0)
    assert.match(srt, /00:08:01,000 --> 00:08:04,250/)
    assert.match(srt, /^1\n/)
    assert.equal(cueCount, 1)
    assert.equal(lastEndSeconds, 484.25)
  })

  test('shifts cue indices by cueNumberOffset', () => {
    const input = `1
00:00:01,000 --> 00:00:02,000
First line.

2
00:00:03,000 --> 00:00:04,000
Second line.`
    const { srt, cueCount } = shiftSrtTimestamps(input, 0, 100)
    assert.match(srt, /^101\n/)
    assert.match(srt, /\n102\n/)
    assert.equal(cueCount, 2)
  })

  test('preserves sub-second milliseconds across the shift', () => {
    const input = `1
00:00:00,123 --> 00:00:00,789
Tick.`
    const { srt } = shiftSrtTimestamps(input, 480, 0)
    // 480.123 → 00:08:00,123; 480.789 → 00:08:00,789
    assert.match(srt, /00:08:00,123 --> 00:08:00,789/)
  })

  test('handles empty input without throwing', () => {
    const r = shiftSrtTimestamps('', 60, 0)
    assert.equal(r.srt, '')
    assert.equal(r.cueCount, 0)
    assert.equal(r.lastEndSeconds, 0)
  })

  test('strips a UTF-8 BOM from the head of the SRT', () => {
    // Whisper occasionally returns SRT with a leading BOM; without
    // stripping it the first cue's "1" wouldn't match the index regex.
    const input = `﻿1
00:00:01,000 --> 00:00:02,000
Hello.`
    const r = shiftSrtTimestamps(input, 0, 5)
    assert.match(r.srt, /^6\n/)
    assert.equal(r.cueCount, 1)
  })

  test('normalises CRLF line endings before shifting', () => {
    const input = `1\r\n00:00:01,000 --> 00:00:02,000\r\nHello.`
    const r = shiftSrtTimestamps(input, 60, 0)
    assert.match(r.srt, /00:01:01,000 --> 00:01:02,000/)
  })

  test('reports lastEndSeconds across multiple cues', () => {
    const input = `1
00:00:01,000 --> 00:00:02,000
First.

2
00:00:05,000 --> 00:00:09,500
Second.`
    const r = shiftSrtTimestamps(input, 100, 0)
    // Second cue end: 9.5 + 100 = 109.5
    assert.equal(r.lastEndSeconds, 109.5)
    assert.equal(r.cueCount, 2)
  })

  test('preserves trailing line attributes after the timecode (e.g. align tags)', () => {
    // Some Whisper variants emit positioning metadata after the timecode.
    // We don't parse it, just preserve it byte-for-byte.
    const input = `1
00:00:01,000 --> 00:00:02,000 X1:10 X2:200
Hello.`
    const r = shiftSrtTimestamps(input, 30, 0)
    assert.match(r.srt, /X1:10 X2:200/)
  })

  test('crosses the hour boundary correctly', () => {
    const input = `1
00:30:00,000 --> 00:30:05,000
Half-hour mark.`
    const r = shiftSrtTimestamps(input, 1800, 0) // +30 min → 60:05
    assert.match(r.srt, /01:00:00,000 --> 01:00:05,000/)
    assert.equal(r.lastEndSeconds, 3605)
  })
})
