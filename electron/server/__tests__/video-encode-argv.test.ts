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

import { buildEncoderArgs, computeWatchdogMs, checkTimelineDurationSanity, crfToVideotoolboxQ } from '../generators/video.js'

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

  test('hardware effort routes through h264_videotoolbox with q:v + allow_sw', () => {
    // Hardware path is a separate code branch — pin its argv shape so a
    // refactor to buildEncoderArgs doesn't silently revert to libx264 or
    // drop the software-fallback flag.
    const args = buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 23, effort: 'hardware' })
    const ci = args.indexOf('-c:v')
    assert.notEqual(ci, -1, 'must specify -c:v')
    assert.equal(args[ci + 1], 'h264_videotoolbox', 'hardware must use videotoolbox encoder')
    // Quality is q:v on videotoolbox (not CRF).
    const qi = args.indexOf('-q:v')
    assert.notEqual(qi, -1, 'videotoolbox must set -q:v')
    assert.equal(args[qi + 1], '65', 'crf 23 → q:v 65 per the linear map')
    // No -crf or -preset on the hardware path — those are libx264 flags.
    assert.equal(args.indexOf('-crf'), -1, 'hardware path must not emit -crf')
    assert.equal(args.indexOf('-preset'), -1, 'hardware path must not emit libx264 -preset')
    // Software-fallback flag must be present so ffmpeg can transparently
    // recover when videotoolbox can't open a session.
    const swi = args.indexOf('-allow_sw')
    assert.notEqual(swi, -1, 'must set -allow_sw 1 for software fallback')
    assert.equal(args[swi + 1], '1')
    // Audio + faststart parity with the libx264 path.
    assert.notEqual(args.indexOf('-movflags'), -1)
  })

  test('hardware effort overrides codec=h265 — no hevc_videotoolbox path', () => {
    // We deliberately don't expose hevc_videotoolbox (quality varies more
    // across hardware). Asking for hardware effort with codec h265 should
    // still produce a single h264_videotoolbox argv — not a confused
    // libx265-mixed-with-videotoolbox set.
    const args = buildEncoderArgs({ codec: 'h265', format: 'mp4', crf: 23, effort: 'hardware' })
    const codecArg = args[args.indexOf('-c:v') + 1]
    assert.equal(codecArg, 'h264_videotoolbox', 'hardware effort always means h264_videotoolbox')
    assert.equal(args.indexOf('libx265'), -1, 'must not also include libx265')
    assert.equal(args.indexOf('-tag:v'), -1, 'hvc1 tag is libx265-only')
  })
})

describe('crfToVideotoolboxQ — CRF→q:v mapping', () => {
  test('high quality CRF (18) maps to q:v 80', () => {
    assert.equal(crfToVideotoolboxQ(18), 80)
  })

  test('medium CRF (23) maps to q:v 65', () => {
    assert.equal(crfToVideotoolboxQ(23), 65)
  })

  test('low CRF (28) maps to q:v 50', () => {
    assert.equal(crfToVideotoolboxQ(28), 50)
  })

  test('clamps to [25, 90] at extremes', () => {
    // Very-high-quality CRF (≤ 0) caps at 90.
    assert.equal(crfToVideotoolboxQ(0), 90)
    assert.equal(crfToVideotoolboxQ(-5), 90)
    // Very-low-quality CRF (≥ 36) floors at 25.
    assert.equal(crfToVideotoolboxQ(36), 26)
    assert.equal(crfToVideotoolboxQ(40), 25)
    assert.equal(crfToVideotoolboxQ(51), 25)
  })
})

describe('computeWatchdogMs — scales with output duration', () => {
  // The 30-min fixed watchdog killed sleep-story renders that legitimately
  // shipped a 2-hour ambient tail. The scaled formula gives long-form
  // renders enough wall-clock to finish; these tests pin the math so a
  // refactor doesn't accidentally re-introduce the floor for everyone.

  test('short outputs hit the 30-min floor', () => {
    // 5 min × 1.5 + 5 min buffer = 12.5 min — well under the floor.
    const ms = computeWatchdogMs(300)
    assert.equal(ms, 30 * 60_000, '5-min output should still get the 30-min floor')
  })

  test('long outputs scale to 1.5× output + 5 min buffer', () => {
    // 9219.5s (the 2026-04-28 case study). Expect ceil(9219.5*1.5)*1000
    // + 5 min = 13829250 + 300000 = 14129250 ms ≈ 235 min.
    const ms = computeWatchdogMs(9219.5)
    assert.equal(ms, Math.ceil(9219.5 * 1.5 * 1000) + 5 * 60_000)
    assert.ok(ms >= 230 * 60_000, 'should give 2.5h render >3.5h wall-clock')
  })

  test('caps at 12 hours so a runaway encode still gets killed', () => {
    // 30h output × 1.5 = 45h scaled — must clamp to 12h.
    const ms = computeWatchdogMs(30 * 3600)
    assert.equal(ms, 12 * 3600 * 1000)
  })

  test('env override wins unconditionally', () => {
    // Even for a tiny 60s clip, an explicit override must apply.
    assert.equal(computeWatchdogMs(60, '90000'), 90000)
    // Bogus env (NaN, zero, negative) falls through to scaling logic.
    assert.equal(computeWatchdogMs(60, 'not-a-number'), 30 * 60_000)
    assert.equal(computeWatchdogMs(60, '0'), 30 * 60_000)
    assert.equal(computeWatchdogMs(60, '-5'), 30 * 60_000)
  })

  test('non-positive output duration falls back to floor', () => {
    assert.equal(computeWatchdogMs(0), 30 * 60_000)
    assert.equal(computeWatchdogMs(-100), 30 * 60_000)
    assert.equal(computeWatchdogMs(NaN), 30 * 60_000)
  })
})

describe('checkTimelineDurationSanity — warn-only on long tails', () => {
  // The original implementation aborted when the timeline > 2× narration,
  // which broke sleep-story workflows that intentionally append 2-hour
  // ambient tails. These tests pin the warn-only behavior so we don't
  // re-introduce the abort.

  test('empty clip list returns no warning', () => {
    assert.deepEqual(checkTimelineDurationSanity([], 600), {})
  })

  test('short timeline (under reference) returns no warning', () => {
    // 30s intro + 60s outro on a 33-min narration = nothing to flag.
    const result = checkTimelineDurationSanity(
      [
        { path: '/x/intro.mp4', duration: 30, anchor: 'before_intro' },
        { path: '/x/outro.mp4', duration: 60, anchor: 'after_outro' },
      ],
      1980,
    )
    assert.deepEqual(result, {})
  })

  test('long sleep-story tail is allowed with a heads-up warning', () => {
    // The exact 2026-04-28 case: 7212s after_scenes tail on a 1977s
    // narration. Old code threw; new code warns and proceeds.
    const result = checkTimelineDurationSanity(
      [{ path: '/x/2hr_ambient.mp4', duration: 7212, anchor: 'after_scenes' }],
      1977,
    )
    assert.ok(result.warning, 'should surface a warning for long tails')
    assert.match(result.warning!, /7212\.0s/, 'warning includes total duration')
    assert.match(result.warning!, /watchdog auto-extends/, 'warning reassures user about completion')
    // Critically, the result has no `ok: false` shape — there is no
    // way for the caller to abort. The contract is warn-only.
    assert.equal(('ok' in result && (result as any).ok === false), false)
  })
})
