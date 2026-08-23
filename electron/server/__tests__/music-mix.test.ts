/**
 * v1.4.37 — choosing the tracks for one music video.
 *
 * The builder is pure, so every rule can be stated as a fact rather than
 * observed by rendering an hour of audio. The three that matter:
 *
 * 1. No track twice in one video.
 * 2. Siblings never adjacent — two songs from ONE request sound like cousins,
 *    and back to back a listener hears one song looping.
 * 3. A shortfall is REPORTED. Silently handing back a shorter video, or
 *    silently buying more music, are both wrong; the second is the v1.0.114 bug.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MIX_RULES,
  buildMusicMix,
  formatTimestamp,
  renderTracklist,
  type MixCandidate,
} from '../services/music-mix.js'

const track = (over: Partial<MixCandidate> & { filename: string }): MixCandidate => ({
  title: over.filename,
  duration_sec: 180,
  enabled: true,
  ...over,
})

const library = (n: number, over: Partial<MixCandidate> = {}): MixCandidate[] =>
  Array.from({ length: n }, (_, i) => track({ filename: `t${i + 1}.mp3`, title: `Track ${i + 1}`, ...over }))

describe('filling a runtime', () => {
  test('an hour is filled from a library that has enough', () => {
    const plan = buildMusicMix(library(40), 3600, 'ep1')
    assert.equal(plan.shortfall_sec, 0)
    assert.ok(plan.total_sec >= 3600, 'the target must be met or exceeded')
    assert.ok(plan.entries.length >= 20)
  })

  test('no track appears twice in one video', () => {
    const plan = buildMusicMix(library(40), 3600, 'ep1')
    const names = plan.entries.map(e => e.filename)
    assert.equal(new Set(names).size, names.length, 'a repeat inside one hour is audible')
  })

  test('start times are cumulative and match the durations', () => {
    const plan = buildMusicMix(library(5), 600, 'ep1')
    let running = 0
    for (const entry of plan.entries) {
      assert.equal(entry.start_sec, Math.round(running))
      running += entry.duration_sec
    }
    assert.equal(plan.total_sec, Math.round(running))
  })

  test('it overshoots rather than cutting a track in half', () => {
    // 3 tracks x 180s = 540s against a 500s target. Truncating the last song
    // mid-bar is audibly wrong, and runtime is free once the library exists.
    const plan = buildMusicMix(library(10), 500, 'ep1')
    assert.ok(plan.total_sec >= 500)
    assert.equal(plan.shortfall_sec, 0)
  })

  test('overshoot can be turned off, and then it stops short instead', () => {
    const plan = buildMusicMix(library(10), 500, 'ep1', { ...DEFAULT_MIX_RULES, overshoot: false })
    assert.ok(plan.total_sec <= 500)
  })
})

describe('a shortfall is reported, never papered over', () => {
  test('too small a library returns what it has AND says how short it is', () => {
    const plan = buildMusicMix(library(3), 3600, 'ep1')
    assert.equal(plan.entries.length, 3)
    assert.equal(plan.total_sec, 540)
    assert.equal(plan.shortfall_sec, 3060)
    assert.match(plan.notes.join(' '), /short of the target/)
  })

  test('it never generates to cover the gap — that is the caller\'s offer to make', () => {
    const plan = buildMusicMix(library(2), 3600, 'ep1')
    assert.match(plan.notes.join(' '), /Nothing was generated/,
      'a builder that bought music during assembly is the v1.0.114 bug wearing a new hat')
  })

  test('an empty library is a shortfall, not a crash', () => {
    const plan = buildMusicMix([], 3600, 'ep1')
    assert.deepEqual(plan.entries, [])
    assert.equal(plan.shortfall_sec, 3600)
  })

  test('disabled tracks and unmeasured tracks are excluded and counted', () => {
    const plan = buildMusicMix([
      track({ filename: 'a.mp3' }),
      track({ filename: 'b.mp3', enabled: false }),
      track({ filename: 'c.mp3', duration_sec: 0 }),
    ], 600, 'ep1')
    assert.deepEqual(plan.entries.map(e => e.filename), ['a.mp3'])
    assert.match(plan.notes.join(' '), /2 track\(s\) skipped/)
  })
})

describe('siblings are kept apart', () => {
  test('two takes of one request never land next to each other', () => {
    const pair = [
      track({ filename: 'adagio-1.mp3', sibling_group: 'g1' }),
      track({ filename: 'adagio-2.mp3', sibling_group: 'g1' }),
    ]
    const plan = buildMusicMix([...pair, ...library(20)], 3600, 'ep1')
    const positions = plan.entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.filename.startsWith('adagio-'))
      .map(({ i }) => i)
    if (positions.length === 2) {
      assert.ok(Math.abs(positions[0]! - positions[1]!) > DEFAULT_MIX_RULES.siblingGapTracks,
        `siblings landed ${Math.abs(positions[0]! - positions[1]!)} apart; two cousins in a row `
        + 'sound like one song repeating')
    }
  })

  test('the gap is a setting, and zero means the rule is off', () => {
    const pair = [
      track({ filename: 's1.mp3', sibling_group: 'g' }),
      track({ filename: 's2.mp3', sibling_group: 'g' }),
    ]
    const plan = buildMusicMix(pair, 360, 'ep1', { siblingGapTracks: 0, overshoot: true })
    assert.equal(plan.entries.length, 2, 'with the rule off both may be placed')
    assert.equal(plan.blocked_by_sibling_rule, 0)
  })

  test('a library of nothing but siblings reports why it stalled', () => {
    // Two cousins and a gap of 5: the second can never be placed. That must
    // read as "held back", not as "your library is smaller than you think".
    const plan = buildMusicMix([
      track({ filename: 's1.mp3', sibling_group: 'g' }),
      track({ filename: 's2.mp3', sibling_group: 'g' }),
    ], 3600, 'ep1')
    assert.equal(plan.entries.length, 1)
    assert.equal(plan.blocked_by_sibling_rule, 1)
    assert.match(plan.notes.join(' '), /same request/)
  })
})

describe('rotation and determinism', () => {
  test('least-used tracks are chosen first', () => {
    const plan = buildMusicMix([
      track({ filename: 'old.mp3', times_used: 9 }),
      track({ filename: 'fresh.mp3', times_used: 0 }),
    ], 180, 'ep1')
    assert.equal(plan.entries[0]!.filename, 'fresh.mp3',
      'a big library must rotate rather than lean on whatever sorts first')
  })

  test('the same library and episode always produce the same running order', () => {
    // A rebuild after a crash must not reorder a video whose tracklist is
    // already published in a description.
    const a = buildMusicMix(library(20), 1800, 'EP0007')
    const b = buildMusicMix(library(20), 1800, 'EP0007')
    assert.deepEqual(a.entries.map(e => e.filename), b.entries.map(e => e.filename))
  })

  test('different episodes do not all open with the same song', () => {
    const orders = ['EP0001', 'EP0002', 'EP0003', 'EP0004']
      .map(seed => buildMusicMix(library(30), 1800, seed).entries[0]!.filename)
    assert.ok(new Set(orders).size > 1, 'every video opening identically would be obvious')
  })
})

describe('the tracklist a viewer clicks', () => {
  test('under an hour reads M:SS, over an hour reads H:MM:SS', () => {
    assert.equal(formatTimestamp(0), '0:00')
    assert.equal(formatTimestamp(65), '1:05')
    assert.equal(formatTimestamp(600), '10:00')
    assert.equal(formatTimestamp(3600), '1:00:00')
    assert.equal(formatTimestamp(3725), '1:02:05')
  })

  test('it is derived from the stitch, so it cannot drift from the audio', () => {
    const plan = buildMusicMix(library(3), 540, 'ep1')
    const lines = renderTracklist(plan).split('\n')
    assert.equal(lines.length, plan.entries.length)
    // Which track opens is decided by the seeded shuffle, not by sort order —
    // that is the point of the shuffle. What must hold is that the FIRST line
    // starts at zero and names whatever track actually plays first.
    assert.equal(lines[0], `0:00 ${plan.entries[0]!.title}`)
    for (const [i, line] of lines.entries()) {
      assert.ok(line.startsWith(formatTimestamp(plan.entries[i]!.start_sec)))
    }
  })

  test('an empty plan renders an empty tracklist rather than a stray line', () => {
    assert.equal(renderTracklist(buildMusicMix([], 600, 'ep1')), '')
  })
})
