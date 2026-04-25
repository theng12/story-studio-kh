/**
 * Snapshot-pin the codec/audio/pixfmt argv shape produced by
 * `buildEncoderArgs` — the pure portion of the final encode argv pulled out
 * of `runFinalComposition` (electron/server/generators/video.ts).
 *
 * The final encode is the largest spawn site in the generator (~2300 LOC of
 * surrounding logic) and previously had zero argv-shape tests. A flag flip
 * here — wrong codec, wrong CRF, dropped `+faststart`, swapped audio codec —
 * silently ships the wrong file. Snapshot tests catch those edits at CI
 * time without spawning ffmpeg or building an episode fixture: the encoder
 * args portion is pure (just `codec`, `format`, `crf`, `effort` in →
 * `string[]` out), so the test asserts the array shape directly.
 *
 * If a future change to `buildEncoderArgs` is intentional, update the
 * frozen arrays here in the same commit.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildEncoderArgs } from '../generators/video.js'

describe('buildEncoderArgs — codec/format matrix', () => {
  test('mp4 + h264 + medium → libx264 with aac/yuv420p/+faststart', () => {
    const args = buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 23, effort: 'medium' })
    assert.deepEqual(args, [
      '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
      '-c:a', 'aac', '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    ])
  })

  test('mp4 + h265 + slow → libx265 with hvc1 tag and aac/yuv420p/+faststart', () => {
    const args = buildEncoderArgs({ codec: 'h265', format: 'mp4', crf: 18, effort: 'slow' })
    assert.deepEqual(args, [
      '-c:v', 'libx265', '-crf', '18', '-preset', 'slow',
      '-tag:v', 'hvc1',
      '-c:a', 'aac', '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    ])
  })

  test('webm short-circuits to libvpx-vp9 + libopus regardless of codec/effort', () => {
    // VP9's CRF tier replaces H.264's; effort is ignored on the WebM branch.
    const fromH264 = buildEncoderArgs({ codec: 'h264', format: 'webm', crf: 28, effort: 'ultrafast' })
    const fromH265 = buildEncoderArgs({ codec: 'h265', format: 'webm', crf: 28, effort: 'slow' })
    const expected = [
      '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0',
      '-c:a', 'libopus',
    ]
    assert.deepEqual(fromH264, expected)
    assert.deepEqual(fromH265, expected, 'WebM branch must ignore the codec selector')
  })

  test('CRF and effort propagate through to the argv (no silent rounding/clamping)', () => {
    const args = buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 32, effort: 'ultrafast' })
    // Pin the exact positions — a flag-order shuffle would change ffmpeg's
    // interpretation (e.g. -preset before -c:v has no effect).
    const ci = args.indexOf('-crf')
    const pi = args.indexOf('-preset')
    assert.equal(args[ci + 1], '32')
    assert.equal(args[pi + 1], 'ultrafast')
    assert.ok(ci < pi, '-crf must precede -preset')
  })

  test('mp4 + h264 always emits +faststart (web playback invariant)', () => {
    const args = buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 23, effort: 'medium' })
    const idx = args.indexOf('-movflags')
    assert.notEqual(idx, -1, 'h264 mp4 must request faststart movflags')
    assert.equal(args[idx + 1], '+faststart')
  })
})
