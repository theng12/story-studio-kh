/**
 * Snapshot-pin the ffmpeg argv produced by `buildSfxMixArgs` (lib/sfx-mixer.ts).
 *
 * The mix is a spawn site; a wrong filter (dropped adelay, amix normalize back
 * on, wrong map) silently ships bad audio. The arg builder is pure (cues in →
 * string[] out), so we assert the array shape without spawning ffmpeg.
 *
 * If a change to buildSfxMixArgs is intentional, update the expectations here in
 * the same commit.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildSfxMixArgs, type MixCue } from '../lib/sfx-mixer.js'

describe('buildSfxMixArgs', () => {
  test('one bed + one spot → correct inputs, filtergraph, map', () => {
    const cues: MixCue[] = [
      { kind: 'bed', path: '/sfx/city.mp3', gain_db: -20, start_sec: 0, end_sec: 30 },
      { kind: 'spot', path: '/sfx/door.mp3', gain_db: -12, start_sec: 12.4 },
    ]
    const args = buildSfxMixArgs({ basePath: '/ep/merged.mp3', cues, outPath: '/ep/merged_sfx.mp3' })

    // inputs: base + 2 clips
    assert.deepEqual(args.slice(0, 7), [
      '-y', '-i', '/ep/merged.mp3', '-i', '/sfx/city.mp3', '-i', '/sfx/door.mp3',
    ])

    const fcIdx = args.indexOf('-filter_complex')
    assert.ok(fcIdx > 0)
    const fc = args[fcIdx + 1]!
    // bed: loop → trim to 30.000s span → volume → delay 0ms
    assert.match(fc, /\[1:a\]aloop=loop=-1:size=2147483647,atrim=duration=30\.000,volume=-20dB,adelay=0:all=1\[c0\]/)
    // spot: volume → delay 12400ms
    assert.match(fc, /\[2:a\]volume=-12dB,adelay=12400:all=1\[c1\]/)
    // amix of base + 2 cues, no auto-normalize, length follows the base
    assert.match(fc, /\[0:a\]\[c0\]\[c1\]amix=inputs=3:duration=first:normalize=0\[mix\]/)

    // output mapping + codec (last 7 args)
    assert.deepEqual(args.slice(-7), [
      '-map', '[mix]', '-c:a', 'libmp3lame', '-b:a', '192k', '/ep/merged_sfx.mp3',
    ])
  })

  test('spot-only plan still amixes against the base (inputs=2)', () => {
    const cues: MixCue[] = [{ kind: 'spot', path: '/sfx/whoosh.mp3', gain_db: -10, start_sec: 3 }]
    const args = buildSfxMixArgs({ basePath: '/ep/a.mp3', cues, outPath: '/ep/o.mp3' })
    const fc = args[args.indexOf('-filter_complex') + 1]!
    assert.match(fc, /amix=inputs=2:duration=first:normalize=0\[mix\]/)
    assert.match(fc, /adelay=3000:all=1/)
  })

  test('bed with no end_sec falls back to a minimum non-zero span', () => {
    const cues: MixCue[] = [{ kind: 'bed', path: '/sfx/b.mp3', gain_db: -18, start_sec: 5 }]
    const args = buildSfxMixArgs({ basePath: '/ep/a.mp3', cues, outPath: '/ep/o.mp3' })
    const fc = args[args.indexOf('-filter_complex') + 1]!
    assert.match(fc, /atrim=duration=0\.050/)
    assert.match(fc, /adelay=5000:all=1/)
  })

  test('map + codec tail is exactly as expected', () => {
    const cues: MixCue[] = [{ kind: 'spot', path: '/s.mp3', gain_db: -12, start_sec: 1 }]
    const args = buildSfxMixArgs({ basePath: '/b.mp3', cues, outPath: '/out.mp3' })
    assert.deepEqual(args.slice(-7), ['-map', '[mix]', '-c:a', 'libmp3lame', '-b:a', '192k', '/out.mp3'])
  })
})
