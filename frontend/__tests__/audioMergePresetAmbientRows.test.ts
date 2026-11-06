/**
 * release-382 Audio Assembly audit — two small fixes, one lane.
 *
 * 1. Preset apply replaced the ambient rows WHOLE and put each clip's own
 *    source back BY INDEX: after a reorder the saved fades/volume landed on
 *    another clip, and a shorter preset dropped live clips entirely. The page
 *    now delegates to `applyAmbientPresetRows`, which keeps every live row
 *    (id, source, position) and matches settings by the preset row's id.
 *
 * 2. The duration estimate omitted the enabled intro/music lead-in/tail. The
 *    page counts what its own controls know and names the rest as NOT counted
 *    (§6) — never zero.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { applyAmbientPresetRows } from '../utils/audio-merge-preset.js'

interface Row {
  id: string
  source_path: string
  source_filename?: string
  enabled: boolean
  volume: number
  fade_in: number
  fade_out: number
  loop?: boolean
}

function clip(id: string, path: string, volume: number, fadeIn: number): Row {
  return {
    id,
    source_path: path,
    source_filename: path.split('/').pop()!,
    enabled: true,
    volume,
    fade_in: fadeIn,
    fade_out: 3,
    loop: true,
  }
}

describe('a preset\'s ambient settings land on the clip they belong to', () => {
  test('a reordered list keeps each clip its own settings, id and source', () => {
    // Live order after the customer reordered: b, a. The preset was saved
    // while the order was still a, b.
    const live = [clip('amb_b', '/ep/b.mp3', 50, 5), clip('amb_a', '/ep/a.mp3', 10, 1)]
    const preset = [
      { id: 'amb_a', enabled: true, volume: 11, fade_in: 2, fade_out: 4, loop: false },
      // No `loop` key: a partial row must not blank the live value.
      { id: 'amb_b', enabled: false, volume: 55, fade_in: 6, fade_out: 7 },
    ]

    applyAmbientPresetRows(live, preset)

    assert.deepEqual(live.map(row => row.id), ['amb_b', 'amb_a'], 'the session\'s order stands')
    assert.equal(live[0]!.source_path, '/ep/b.mp3', 'b keeps its clip')
    assert.equal(live[0]!.volume, 55, 'b gets b\'s saved settings, by id — not by position')
    assert.equal(live[0]!.enabled, false)
    assert.equal(live[0]!.loop, true, 'an absent key keeps the live value instead of blanking it')
    assert.equal(live[1]!.source_path, '/ep/a.mp3')
    assert.equal(live[1]!.volume, 11)
    assert.equal(live[1]!.fade_out, 4)
    assert.equal(live[1]!.loop, false)
  })

  test('unmatched rows cannot take clips reserved for later identity matches', () => {
    const live = [clip('amb_a', '/ep/a.mp3', 10, 1), clip('amb_b', '/ep/b.mp3', 20, 2)]
    applyAmbientPresetRows(live, [
      { id: 'old_session', volume: 31 },
      { id: 'amb_a', volume: 42 },
    ])
    assert.equal(live[0]!.volume, 42, 'a keeps its explicitly matched settings')
    assert.equal(live[1]!.volume, 31, 'only the unmatched live clip gets positional settings')
    assert.deepEqual(live.map(row => row.source_path), ['/ep/a.mp3', '/ep/b.mp3'])
  })

  test('a shorter preset never drops a live clip', () => {
    const live = [
      clip('amb_1', '/ep/1.mp3', 10, 1),
      clip('amb_2', '/ep/2.mp3', 20, 2),
      clip('amb_3', '/ep/3.mp3', 30, 3),
    ]
    const preset = [
      { id: 'amb_1', enabled: true, volume: 41, fade_in: 1, fade_out: 1, loop: true },
      { id: 'amb_2', enabled: true, volume: 42, fade_in: 2, fade_out: 2, loop: true },
    ]

    applyAmbientPresetRows(live, preset)

    assert.equal(live.length, 3, 'the third clip survives')
    assert.equal(live[2]!.source_path, '/ep/3.mp3', 'with its own clip and settings')
    assert.equal(live[2]!.volume, 30)
    assert.equal(live[0]!.volume, 41)
    assert.equal(live[1]!.volume, 42)
  })

  test('a longer preset appends its extra layers without touching the clips', () => {
    const live = [clip('n_1', '/ep/new.mp3', 20, 2)]
    const preset = [
      { id: 'amb_old', enabled: true, volume: 30, fade_in: 1, fade_out: 1, loop: true },
      { id: 'amb_extra', enabled: true, volume: 40, fade_in: 1, fade_out: 1, loop: true },
    ]

    applyAmbientPresetRows(live, preset)

    assert.equal(live.length, 2)
    assert.equal(live[0]!.id, 'n_1', 'the live clip keeps its identity')
    assert.equal(live[0]!.source_path, '/ep/new.mp3')
    assert.equal(live[0]!.volume, 30, 'the first saved row applies to it positionally')
    assert.equal(live[1]!.id, 'amb_extra', 'the extra layer arrives as the row it is')
    assert.equal('source_path' in live[1]!, false, 'a preset row never carries a clip')
  })

  test('mount-time auto-apply (no live clips) takes the preset rows as they are', () => {
    const live: Row[] = []
    const preset = [
      { id: 'amb_1', enabled: true, volume: 20, fade_in: 2, fade_out: 3, loop: true, source_filename: 'rain.mp3' },
      { id: 'amb_2', enabled: false, volume: 10, fade_in: 1, fade_out: 1, loop: true, source_filename: 'wind.mp3' },
    ]

    applyAmbientPresetRows(live, preset)

    assert.equal(live.length, 2)
    assert.deepEqual(live.map(row => row.id), ['amb_1', 'amb_2'])
    assert.equal(live[1]!.enabled, false)
    assert.equal(live[0]!.source_filename, 'rain.mp3', 'the display name still renders the row')
    assert.equal('source_path' in live[0]!, false, 'and the stripped path stays stripped')
  })
})

describe('the estimate counts what it can and names what it cannot', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url)),
    'utf8'
  )

  test('lead-in and intro gap join the sum; unmeasurable parts say "not counted"', () => {
    assert.match(page, /\+ musicLeadInSeconds\.value \+ introGapSeconds\.value/,
      'the enabled lead-in and intro gap are part of the merged duration')
    assert.match(page, /not counted: \{\{ estimatedUncounted\.join/,
      'the summary line names what the number excludes (§6: never a silent zero)')
    assert.match(page, /parts\.push\('intro clip length'\)/, 'the intro clip needs a probe this page never runs')
    assert.match(page, /parts\.push\('closing tail'\)/, 'the tail is resolved server-side with no route here')
  })

  test('preset apply no longer replaces the ambient rows', () => {
    assert.match(page, /applyAmbientPresetRows\(ambientTracks, data\.ambient_tracks\)/)
    assert.doesNotMatch(page, /ambientTracks\.splice\(0, ambientTracks\.length/,
      'the wholesale row replacement the audit flagged is gone')
  })
})
