/**
 * No new black endings (owner, 2026-11-07): *"why cut it? it's finished? let
 * it be. just prevent new ones."* Finished videos are never touched; a NEW
 * render that asks for `black-screen` or `fade-to-black` draws hold-last-scene
 * over the SAME tail instead — same seconds, same closing music, same length
 * arithmetic, and the request says what it substituted.
 *
 * Pure: no FFmpeg, no render, no stored file written.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { describe } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { VideoPostAudio } from '../models/types.js'

const { postRollSeconds, preventBlackTail } = await import('../lib/closing-tail.js')
const { resolveVideoLengths } = await import('../generators/video.js')

const videoSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../generators/video.ts'),
  'utf8',
)

describe('preventBlackTail', () => {
  test('black-screen becomes hold-last-scene over the same tail, music kept', () => {
    const raw: VideoPostAudio = {
      behavior: 'black-screen', fade_duration: 5, tail_seconds: 25,
      closing_music: { volume: 80, duck_release_sec: 2, fade_out_sec: 6 },
    }
    const safe = preventBlackTail(raw)
    assert.equal(safe.behavior, 'hold-last-scene')
    assert.equal(safe.tail_seconds, 25)
    assert.deepEqual(safe.closing_music, raw.closing_music, 'the closing music rides along untouched')
    assert.equal(postRollSeconds(safe), postRollSeconds(raw), 'the tail length is identical')
    assert.equal(raw.behavior, 'black-screen', 'the caller’s own block is not mutated')
  })

  test('fade-to-black becomes hold-last-scene over the fade length', () => {
    const raw: VideoPostAudio = { behavior: 'fade-to-black', fade_duration: 12 }
    const safe = preventBlackTail(raw)
    assert.equal(safe.behavior, 'hold-last-scene')
    assert.equal(safe.tail_seconds, 12, 'fade_duration is the length the fade would have drawn')
    assert.equal(postRollSeconds(safe), postRollSeconds(raw))
  })

  test('a fade with no usable duration carries the same default the fade had', () => {
    const raw: VideoPostAudio = { behavior: 'fade-to-black', fade_duration: 0 }
    const safe = preventBlackTail(raw)
    assert.equal(safe.tail_seconds, 5, 'postRollSeconds fell back to 5 for the fade; hold keeps that')
    assert.equal(postRollSeconds(safe), postRollSeconds(raw))
  })

  test('a legacy block that names no behavior takes the old default, then holds', () => {
    const raw = { fade_duration: 15 } as any as VideoPostAudio // runtime legacy: behavior omitted
    const safe = preventBlackTail(raw)
    assert.equal(safe.behavior, 'hold-last-scene')
    assert.equal(safe.tail_seconds, 15, 'no behavior meant fade-to-black at fade_duration (||5)')
    assert.equal(postRollSeconds(safe), postRollSeconds(raw))
    const bare = { } as any as VideoPostAudio // no behavior and no duration: the old fade-5 default
    const heldBare = preventBlackTail(bare)
    assert.equal(heldBare.behavior, 'hold-last-scene')
    assert.equal(heldBare.tail_seconds, 5)
    assert.equal(postRollSeconds(heldBare), postRollSeconds(bare))
  })

  test('hold-last-scene and the no-tail behaviors pass through untouched', () => {
    const hold: VideoPostAudio = { behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: 20 }
    assert.equal(preventBlackTail(hold), hold, 'the same block back — nothing to substitute')
    const hard: VideoPostAudio = { behavior: 'hard-cut', fade_duration: 5 }
    assert.equal(preventBlackTail(hard), hard)
    const cycling: VideoPostAudio = { behavior: 'continue-cycling', fade_duration: 5 }
    assert.equal(preventBlackTail(cycling), cycling)
  })

  test('the video’s length arithmetic is unchanged by the substitution', () => {
    const raw: VideoPostAudio = { behavior: 'black-screen', fade_duration: 5, tail_seconds: 25 }
    const before = resolveVideoLengths({ sourceDurationSec: 120, bakedClosingTailSec: 0, postAudio: raw })
    const after = resolveVideoLengths({ sourceDurationSec: 120, bakedClosingTailSec: 0, postAudio: preventBlackTail(raw) })
    assert.deepEqual(after, before, 'speech end, tail and total are the same numbers')
    assert.equal(after.targetDurationSec, 145)
    // A baked tail still wins over the request, black or not — the master is the length.
    const baked = resolveVideoLengths({ sourceDurationSec: 145, bakedClosingTailSec: 25, postAudio: preventBlackTail(raw) })
    assert.equal(baked.narrationDurationSec, 120)
    assert.equal(baked.targetDurationSec, 145)
  })
})

describe('the render applies the guard', () => {
  test('generateVideo resolves its post-audio through preventBlackTail', () => {
    assert.match(videoSource, /const postAudio = preventBlackTail\(requestedPostAudio\)/,
      'step 9 must substitute before anything draws')
  })

  test('no behavior fallback in the renderer can still pick a black ending', () => {
    assert.doesNotMatch(videoSource, /behavior \|\| 'fade-to-black'/,
      "buildConcatList's absent-behavior fallback must not draw black")
  })
})
