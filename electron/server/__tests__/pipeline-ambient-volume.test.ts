/**
 * Pipeline batch — ambient_tracks volume normalisation (v1.0.71+).
 *
 * The bundle save format stores ambient_tracks volume on a 0-100 scale
 * (matches the page UI slider). FFmpeg's `volume=` filter wants a 0-1
 * decimal — values above 1 are AMPLIFICATION (not 100% loudness), so
 * a 30% slider that reaches FFmpeg as 30.00 produces clipping, not
 * 30% volume.
 *
 * Earlier versions used a heuristic `t.volume > 1 ? /100 : t.volume`
 * that was ambiguous at exactly 1.0 — couldn't distinguish "100% on
 * 0-1 scale" from "1% on 0-100 scale". Since ambient_tracks were
 * 0-100 from v1.0.55 inception (no legacy 0-1 saves to protect), we
 * dropped the heuristic and unconditionally divide by 100, matching
 * intro / music / background_noise.
 *
 * These tests lock that contract so a future "fix" doesn't reintroduce
 * the ambiguity.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveStepParams } from '../routes/pipeline.js'

const fakePreset = (data: any) => ({ id: 'p1', name: 'Test', data })

describe('resolveStepParams audio_merge — ambient_tracks volume', () => {
  test('30% slider value normalises to 0.3 decimal', () => {
    const params = resolveStepParams('audio_merge', 'EP0001', '', fakePreset({
      ambient_tracks: [
        { id: 'a', enabled: true, source_path: '/tmp/rain.mp3', volume: 30 },
      ],
    }))
    const t = (params.ambient_tracks as any[])[0]
    assert.equal(t.volume, 0.3)
  })

  test('100% slider value normalises to 1.0 decimal', () => {
    const params = resolveStepParams('audio_merge', 'EP0001', '', fakePreset({
      ambient_tracks: [
        { id: 'a', enabled: true, source_path: '/tmp/rain.mp3', volume: 100 },
      ],
    }))
    const t = (params.ambient_tracks as any[])[0]
    assert.equal(t.volume, 1.0)
  })

  test('1% slider value normalises to 0.01 decimal (closes the v1.0.55 ambiguity)', () => {
    // Pre-v1.0.71 the heuristic `> 1 ? /100 : keep` returned 1.0 here,
    // which FFmpeg interpreted as 100% loudness — a 100× louder result
    // than what the user clicked. With the unconditional divide we
    // now correctly emit 0.01 (1% loudness). Real corner case but
    // closes the volume_scale audit footgun.
    const params = resolveStepParams('audio_merge', 'EP0001', '', fakePreset({
      ambient_tracks: [
        { id: 'a', enabled: true, source_path: '/tmp/rain.mp3', volume: 1 },
      ],
    }))
    const t = (params.ambient_tracks as any[])[0]
    assert.equal(t.volume, 0.01)
  })

  test('clamps above 1.0 (sanity for user input or legacy bundle)', () => {
    // 150 / 100 = 1.5 → clamps to 1.0 max. Belt-and-braces; FFmpeg
    // would happily amplify, so the clamp prevents accidental clipping.
    const params = resolveStepParams('audio_merge', 'EP0001', '', fakePreset({
      ambient_tracks: [
        { id: 'a', enabled: true, source_path: '/tmp/rain.mp3', volume: 150 },
      ],
    }))
    const t = (params.ambient_tracks as any[])[0]
    assert.equal(t.volume, 1.0)
  })

  test('clamps below 0 (sanity)', () => {
    const params = resolveStepParams('audio_merge', 'EP0001', '', fakePreset({
      ambient_tracks: [
        { id: 'a', enabled: true, source_path: '/tmp/rain.mp3', volume: -10 },
      ],
    }))
    const t = (params.ambient_tracks as any[])[0]
    assert.equal(t.volume, 0)
  })

  test('non-numeric volume defaults to 1.0', () => {
    const params = resolveStepParams('audio_merge', 'EP0001', '', fakePreset({
      ambient_tracks: [
        { id: 'a', enabled: true, source_path: '/tmp/rain.mp3', volume: 'loud' as any },
      ],
    }))
    const t = (params.ambient_tracks as any[])[0]
    assert.equal(t.volume, 1)
  })

  test('filters out disabled / no-source tracks', () => {
    const params = resolveStepParams('audio_merge', 'EP0001', '', fakePreset({
      ambient_tracks: [
        { id: 'a', enabled: true,  source_path: '/tmp/rain.mp3', volume: 50 },
        { id: 'b', enabled: false, source_path: '/tmp/wind.mp3', volume: 50 },
        { id: 'c', enabled: true,  source_path: '',              volume: 50 },
      ],
    }))
    const tracks = params.ambient_tracks as any[]
    assert.equal(tracks.length, 1)
    assert.equal(tracks[0].id, 'a')
  })
})
