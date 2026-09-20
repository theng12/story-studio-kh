/**
 * ffprobe's "N/A" is not a measurement — v1.4.197
 *
 * ffprobe reports an unmeasurable field as the *string* `'N/A'`, not by leaving
 * it out. The b-roll indexer read duration with
 *
 *     parseFloat(stream.duration || format.duration || '0')
 *
 * and `'N/A'` is truthy, so the `||` stopped at the stream and never reached
 * `format.duration` — the field that actually holds the value for some codecs.
 * `parseFloat('N/A')` is then `NaN`, which the caller flattened to `0`. A clip
 * that ffprobe could measure perfectly well was indexed as **0 seconds long**,
 * which downstream reads as "no usable footage". Same shape for width and
 * height via `Number(stream.width) || 0`.
 *
 * AGENTS.md §6: a zero that means two things is a defect. These tests pin which
 * zero it is, and pin a non-zero so a function that always returns 0 fails.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseFfprobeNumber, probeDurationSeconds } from '../lib/broll-indexer.js'

test('an unmeasurable ffprobe field is not a number', () => {
  assert.equal(parseFfprobeNumber('N/A'), null)
  assert.equal(parseFfprobeNumber('n/a'), null)
  assert.equal(parseFfprobeNumber(''), null)
  assert.equal(parseFfprobeNumber('   '), null)
  assert.equal(parseFfprobeNumber(undefined), null)
  assert.equal(parseFfprobeNumber(null), null)
  assert.equal(parseFfprobeNumber(NaN), null)
  assert.equal(parseFfprobeNumber(Infinity), null)
  assert.equal(parseFfprobeNumber({}), null)
})

test('a real ffprobe field is still read', () => {
  assert.equal(parseFfprobeNumber('12.5'), 12.5)
  assert.equal(parseFfprobeNumber(12.5), 12.5)
  assert.equal(parseFfprobeNumber('0'), 0)
  assert.equal(parseFfprobeNumber(0), 0)
  assert.equal(parseFfprobeNumber(1920), 1920)
})

test("a stream duration of 'N/A' falls through to the container duration", () => {
  // THE DEFECT. Before this, `'N/A' || '12.5'` stopped at `'N/A'`, parsed to
  // NaN, and the clip was indexed as 0 seconds.
  assert.equal(probeDurationSeconds({ duration: 'N/A' }, { duration: '12.5' }), 12.5)
  // And the honest cases stay honest.
  assert.equal(probeDurationSeconds({ duration: '7.25' }, { duration: '12.5' }), 7.25)
  assert.equal(probeDurationSeconds({}, { duration: '12.5' }), 12.5)
  assert.equal(probeDurationSeconds({ duration: 'N/A' }, {}), 0)
  assert.equal(probeDurationSeconds({}, {}), 0)
  assert.equal(probeDurationSeconds(null, null), 0)
})
