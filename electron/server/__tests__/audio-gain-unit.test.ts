/**
 * The audio generators' level unit, pinned at the boundary that matters.
 *
 * A generator speaks LINEAR GAIN (1 = unchanged). A preset and the Audio
 * Assembly form speak PERCENT (0–100). The conversion happens exactly once,
 * where a preset is merged into a generator request — never at the generator,
 * and never by guessing from a value's size (`1` is 1% from a preset and unity
 * from a caller that already speaks gain).
 *
 * DM0018/PR0039 were the incident: a preset's 8% bed reached the generator as
 * `8`, eight times louder than the voice (owner, 2026-10-26/27).
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { percentGainToLinear, percentGainToUnitLinear } from '../lib/audio-gain.js'
import { resolveStepParams } from '../routes/pipeline.js'
import { musicWithTrack, type PoolTrack } from '../services/music-pool.js'
import { buildMusicLeadInVolumeExpr } from '../generators/audio-merge.js'

const preset = (data: Record<string, unknown>) => ({ id: 'p1', name: 'Mix', data })

describe('percentGainToLinear — a preset percent becomes a linear gain', () => {
  test('8% is 0.08 and 100% is 1 (the DM0018/PR0039 case)', () => {
    assert.equal(percentGainToLinear(8), 0.08)
    assert.equal(percentGainToLinear(100), 1)
    assert.equal(percentGainToLinear(0), 0)
  })

  test('1% is 0.01 — never read as unity (the size guess would say 1)', () => {
    assert.equal(percentGainToLinear(1), 0.01)
  })

  test('a percent stored as a numeric string still converts', () => {
    assert.equal(percentGainToLinear('8'), 0.08)
  })

  test('a value that states no level is undefined, not zero and not the raw value', () => {
    for (const value of [undefined, null, '', '  ', 'loud', Number.NaN, {}, []]) {
      assert.equal(percentGainToLinear(value), undefined, `${JSON.stringify(value)} states no level`)
    }
  })

  test('the unit-linear form clamps to attenuation', () => {
    assert.equal(percentGainToUnitLinear(150), 1)
    assert.equal(percentGainToUnitLinear(-10), 0)
    assert.equal(percentGainToUnitLinear(30), 0.3)
  })
})

describe('pipeline audio_merge — a percent-bearing preset reaches the generator as linear', () => {
  test('music 8, narration 100, intro 100, noise 15, ambient 30', () => {
    const params = resolveStepParams('audio_merge', 'EP0001', '', preset({
      music: { enabled: true, files: [], volume: 8, post_narration_volume: 40 },
      intro: { enabled: true, file: '/tmp/intro.mp3', volume: 100, gap_after: 2 },
      background_noise: { enabled: true, mode: 'preset', preset: 'brown-noise', volume: 15 },
      ambient_tracks: [{ id: 'a', enabled: true, source_path: '/tmp/rain.mp3', volume: 30 }],
      narration_volume: 100,
    }))
    assert.equal(params.music.volume, 0.08)
    assert.equal(params.music.post_narration_volume, 0.4)
    assert.equal(params.intro.volume, 1)
    assert.equal(params.background_noise.volume, 0.15)
    assert.equal((params.ambient_tracks as any[])[0].volume, 0.3)
    assert.equal(params.narration_volume, 1)
  })

  test('a level the preset states badly is omitted, never forwarded raw', () => {
    // The old `?? data.music.volume` fallback forwarded '8' / 'loud' straight into
    // a linear field. Neither may reach the generator.
    const junk = resolveStepParams('audio_merge', 'EP0001', '', preset({
      music: { enabled: true, files: [], volume: 'loud' },
      narration_volume: 'loud',
    }))
    assert.equal('volume' in junk.music, false)
    assert.equal('narration_volume' in junk, false)

    const numericString = resolveStepParams('audio_merge', 'EP0001', '', preset({
      music: { enabled: true, files: [], volume: '8' },
    }))
    assert.equal(numericString.music.volume, 0.08)
  })
})

describe('the generator never converts a gain itself', () => {
  test('a fractional (linear) caller keeps its level exactly', () => {
    // The Audio Assembly page sends 0.08 for an 8% slider. Dividing again here
    // would make it 0.0008 (silent); using it as a percent would make it 8×.
    const expr = buildMusicLeadInVolumeExpr(0, 0.5, 10, 0.08, 0.08)
    assert.match(expr, /0\.080/)
    assert.doesNotMatch(expr, /8\.000/)
  })
})

describe('Music Pool overrides: the track is percent, the request is linear', () => {
  const track = (overrides: Partial<PoolTrack>): PoolTrack => ({
    filename: 'bed.mp3', path: '/music/bed.mp3', enabled: true, label: 'Bed',
    last_used_at: null, last_used_episode: null, ...overrides,
  })
  const request = {
    enabled: true, files: [] as string[], source: 'pool' as const,
    volume: 0.08, post_narration_volume: 0.4, fade_in: 3, fade_out: 5,
  }

  test('a track override in the pool\'s percent shape converts once', () => {
    const out = musicWithTrack(request, track({ volume: 12, post_narration_volume: 50 }))
    assert.equal(out.volume, 0.12)
    assert.equal(out.post_narration_volume, 0.5)
  })

  test('a track with no override leaves the request\'s linear level alone', () => {
    const out = musicWithTrack(request, track({}))
    assert.equal(out.volume, 0.08)
    assert.equal(out.post_narration_volume, 0.4)
  })
})
