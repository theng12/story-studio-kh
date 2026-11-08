/**
 * The owner's pilot outros (2026-11-08): the accepted videos held the last scene for 15 s with the
 * background music, then appended a 30 s outro in SILENCE. The music was already mixed into the
 * merged master and had faded at the end of the held tail, so Video Assembly's `apad` padded the
 * outro with nothing.
 *
 * What is pinned here, without a render:
 *   • Audio Assembly bakes the outro's seconds onto the same closing tail, and a hard cut stays silent;
 *   • the video's two clocks split that tail: held picture = tail − outro music, audio length unchanged;
 *   • the final check measures closing music over the OUTRO span (the true end), not just the held tail;
 *   • a re-mix accepts the extended track only when its narration is unchanged and BOTH tail spans match.
 *
 * It cannot see the FFmpeg mix itself, the guard's outro measurement, or the final encode — a full
 * render test would have to cover those.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { closingTailWithOutro } = await import('../generators/audio-merge.js')
const {
  resolveVideoLengths, finalCheckExpectation, frameGridSeconds,
  expectedClosingTailMusicSec, closingTailMusicMismatch, recordedFinalCheckExpectation,
} = await import('../generators/video.js')
const { remixProblems } = await import('../services/closing-tail-remix.js')

const close = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 0.01, `${label}: ${actual} !== ${expected}`)

const hold = (seconds: number) => ({
  behavior: 'hold-last-scene' as const,
  tail_seconds: seconds,
  fade_duration: 5,
  closing_music: { volume: 100, fade_out_sec: 5, duck_release_sec: 1.5 },
})

test('Audio Assembly adds the outro span to the closing tail, but never to a hard cut', () => {
  assert.deepEqual(closingTailWithOutro(15, 30.2), { seconds: 45.2, outroSec: 30.2 })
  assert.deepEqual(closingTailWithOutro(15, 0), { seconds: 15, outroSec: 0 })
  assert.deepEqual(closingTailWithOutro(0, 30.2), { seconds: 0, outroSec: 0 }, 'a hard cut stays silent')
  assert.deepEqual(closingTailWithOutro(-1, 30.2), { seconds: 0, outroSec: 0 })
})

test('the picture holds only the tail that is not under the outro', () => {
  const lengths = resolveVideoLengths({
    sourceDurationSec: 956.34, bakedClosingTailSec: 45.2, bakedOutroMusicSec: 30.2,
    postAudio: hold(15),
  })
  close(lengths.narrationDurationSec, 911.14, 'speech end')
  close(lengths.postRollSec, 15, 'held picture')
  close(lengths.targetDurationSec, 956.34, 'audio length is the master')

  const legacy = resolveVideoLengths({ sourceDurationSec: 926.14, bakedClosingTailSec: 15, postAudio: hold(15) })
  close(legacy.postRollSec, 15, 'a merge without outro music keeps the whole tail as picture')
})

test('the final check measures closing music over the outro, at the true end', () => {
  const req = { post_audio: hold(15) } as any
  const expected = finalCheckExpectation(req, {
    plannedSec: 956.34, tailSec: 15, bakedTailSec: 45.2, backgroundMusic: true,
    tailFromEndSec: 30.2, outroMusicSec: 30.2, afterOutroSec: 0,
    width: 1080, height: 1920, speechEndSec: 911.14,
  })
  assert.deepEqual(expected.tail, { sec: 15, from_end_sec: 30.2 }, 'black/hold window is still the held tail')
  assert.deepEqual(expected.closing_music_window, { sec: 30.2, from_end_sec: 0 }, 'music window reaches the true end')
  assert.equal(expected.closing_music, true)

  const noOutro = finalCheckExpectation(req, {
    plannedSec: 926.14, tailSec: 15, bakedTailSec: 15, backgroundMusic: true,
    tailFromEndSec: 0, width: 1080, height: 1920,
  })
  assert.equal(noOutro.closing_music_window, undefined, 'no outro music = the historical held-tail check')
})

test('a re-mix is accepted only when the narration and both tail spans match', () => {
  const track = { durationSec: 926.14, tailSec: 15, leadInSec: 3 } as any
  const record = {
    closing_tail_sec: 45.2, closing_outro_sec: 30.2, duration_sec: 956.34,
    opening: { lead_in_sec: 3 },
  }
  assert.deepEqual(remixProblems(record, track, 45.2, 30.2), [])

  const oldTail = { ...record, closing_tail_sec: 15, closing_outro_sec: 0, duration_sec: 926.14 }
  const problems = remixProblems(oldTail, track, 45.2, 30.2)
  assert.ok(problems.some(p => p.includes('closing')), 'a short tail is reported')
  assert.ok(problems.some(p => p.includes('outro')), 'missing outro music is reported')

  // The historical no-outro path (three arguments) is unchanged.
  assert.deepEqual(remixProblems(
    { closing_tail_sec: 25, duration_sec: 148, opening: { lead_in_sec: 3 } },
    { durationSec: 123, tailSec: 0, leadInSec: 3 } as any,
    25,
  ), [])
})

test('a tail whose music span cannot be measured is refused, never read as zero', () => {
  assert.equal(expectedClosingTailMusicSec({ outroSec: null, tailClipSecs: [], fps: 30 }), null)
  assert.equal(expectedClosingTailMusicSec({ outroSec: 30.2, tailClipSecs: [null], fps: 30 }), null)
  close(
    expectedClosingTailMusicSec({ outroSec: 30.2, tailClipSecs: [12.3, 4], fps: 30 })!,
    frameGridSeconds(30.2, 30) + frameGridSeconds(12.3, 30) + 4,
    'outro plus every clip after the held tail, on the prepared frame grid',
  )
})

test('the prepared tail must match the music span within half a second', () => {
  assert.equal(closingTailMusicMismatch(45.2, frameGridSeconds(45.2, 30)), null)
  const short = closingTailMusicMismatch(45.2, 15)
  assert.ok(short?.includes('picture would end before the music'), 'a short picture tail is refused')
  const long = closingTailMusicMismatch(45.2, 60)
  assert.ok(long?.includes('music would end before the picture'), 'a long picture tail is refused')
  assert.equal(closingTailMusicMismatch(0, 0), null, 'no baked outro music has nothing to match')
})

test('a resumed final encode reuses the expectation recorded before it began', () => {
  const expected = finalCheckExpectation({ post_audio: hold(15) } as any, {
    plannedSec: 956.34, tailSec: 15, bakedTailSec: 45.2, backgroundMusic: true,
    tailFromEndSec: 30.2, outroMusicSec: 30.2, afterOutroSec: 0,
    width: 1080, height: 1920, speechEndSec: 911.14,
  })
  assert.deepEqual(recordedFinalCheckExpectation({ final_check: { inputs: 'abc', expected } }, 'abc'), expected)
  assert.equal(recordedFinalCheckExpectation({ final_check: { inputs: 'other', expected } }, 'abc'), null,
    'different stage inputs are not reused')
  assert.equal(recordedFinalCheckExpectation({}, 'abc'), null, 'an older checkpoint with no record is refused')
  assert.equal(recordedFinalCheckExpectation({ final_check: { inputs: 'abc', expected } }, undefined), null)
})
