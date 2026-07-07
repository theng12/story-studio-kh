/**
 * v1.0.521 — pins planStillConcat (generators/timestamp-video-assemble.ts):
 * the decoder-safe plain-stills concat list. JPEG bytes saved as `.png`
 * (browser-extension image flows) used to hit FFmpeg-8's extension-based
 * decoder pick in the concat demuxer — the wedge/flash class v1.0.515 fixed
 * on every OTHER path.
 *
 *   - true-PNG files pass through verbatim (no transcode)
 *   - non-PNG bytes yield exactly one transcode per unique file, and the
 *     list references the transcoded copy
 *   - unsniffable files throw the actionable error
 *   - list shape: one file+duration pair per scene + trailing last-file line
 *     (concat-demuxer idiom) — exactly one pair per scene, no reuse
 *
 * Pure imports only — no temp dirs, no env mutation.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { planStillConcat } from '../generators/timestamp-video-assemble.js'

const mk = (i: number) => `/tmp/transcode-${i}.png`

describe('planStillConcat — decoder-safe stills concat', () => {
  test('true PNGs pass through verbatim, one file+duration pair per scene', () => {
    const entries = [
      { path: '/img/a.png', durationSec: 2.5, sniffed: 'png' },
      { path: '/img/b.png', durationSec: 6.004, sniffed: 'png' },
    ]
    const { lines, transcodes } = planStillConcat(entries, mk)
    assert.equal(transcodes.length, 0, 'no transcodes for real PNGs')
    assert.deepEqual(lines, [
      `file '/img/a.png'`,
      'duration 2.500',
      `file '/img/b.png'`,
      'duration 6.004',
      `file '/img/b.png'`,   // trailing last-frame idiom (single re-statement)
    ])
  })

  test('JPEG-bytes-as-.png yields a transcode entry and the list references the copy', () => {
    const entries = [
      { path: '/img/a.png', durationSec: 3, sniffed: 'mjpeg' },
      { path: '/img/b.png', durationSec: 4, sniffed: 'png' },
    ]
    const { lines, transcodes } = planStillConcat(entries, mk)
    assert.equal(transcodes.length, 1)
    assert.deepEqual(transcodes[0], { src: '/img/a.png', dest: mk(0), decoder: 'mjpeg' })
    assert.equal(lines[0], `file '${mk(0)}'`, 'list points at the transcoded true PNG')
    assert.equal(lines[2], `file '/img/b.png'`, 'real PNG untouched')
  })

  test('a repeated path transcodes only once', () => {
    const entries = [
      { path: '/img/a.png', durationSec: 3, sniffed: 'mjpeg' },
      { path: '/img/a.png', durationSec: 5, sniffed: 'mjpeg' },
    ]
    const { transcodes } = planStillConcat(entries, mk)
    assert.equal(transcodes.length, 1, 'de-duplicated by source path')
  })

  test('unsniffable file throws the actionable error', () => {
    assert.throws(
      () => planStillConcat([{ path: '/img/broken.png', durationSec: 3, sniffed: null }], mk),
      /not a decodable PNG\/JPEG\/WebP.*broken\.png.*Regenerate or replace/s,
    )
  })

  test('durations are emitted with the plan values — no uniform override', () => {
    const durations = [2.5, 6.0, 4.25]
    const entries = durations.map((d, i) => ({ path: `/img/s${i}.png`, durationSec: d, sniffed: 'png' }))
    const { lines } = planStillConcat(entries, mk)
    const emitted = lines.filter(l => l.startsWith('duration ')).map(l => Number(l.slice('duration '.length)))
    assert.deepEqual(emitted, durations)
    const fileLines = lines.filter(l => l.startsWith('file '))
    assert.equal(fileLines.length, durations.length + 1, 'one file line per scene + the trailing idiom line')
  })
})
