/**
 * A versioned final video is still a final video — v1.4.201
 *
 * `upload-queue.ts:391-392` writes `{code}_final_video_v{N}.{ext}` whenever the
 * canonical `{code}_final_video.{ext}` is already taken, so versioned finals are
 * a normal shape on disk — not a corrupt or foreign file.
 *
 * Three matchers required `_final_video` to be followed IMMEDIATELY by the
 * extension dot, so every versioned final was invisible: Settings → Storage
 * counted it as 0 bytes, `hasFinalVideoFast` reported no video for the episode,
 * and media cleanup would not reclaim the space. Nothing announced the
 * discrepancy — the file was simply not seen. AGENTS.md §6.
 *
 * The three now share `isFinalVideoFilename`. This pins the shared predicate;
 * the end-to-end consequence (an episode with ONLY a versioned final reads as
 * having a video) is what the callers were getting wrong.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { isFinalVideoFilename } from '../lib/final-video-name.js'

describe('isFinalVideoFilename', () => {
  test('accepts the canonical and the versioned name', () => {
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_final_video.mp4'), true)
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_final_video_v2.mp4'), true)
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_final_video_v12.mp4'), true)
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_final_video.mov'), true)
  })

  test('is case-insensitive, as the deletion gate already was', () => {
    assert.equal(isFinalVideoFilename('EP0001', 'ep0001_FINAL_VIDEO.mp4'), true)
    assert.equal(isFinalVideoFilename('ep0001', 'EP0001_final_video_v3.mp4'), true)
  })

  test('rejects near misses that are not this episode', () => {
    assert.equal(isFinalVideoFilename('EP0001', 'EP0002_final_video.mp4'), false)
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_final_video_old.mp4'), false)
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_final_videox.mp4'), false)
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_final_video_v.mp4'), false)
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_final_video_2.mp4'), false)
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_final_video'), false)
    assert.equal(isFinalVideoFilename('EP0001', 'EP0001_scene01.mp4'), false)
  })

  test('an empty code never matches', () => {
    assert.equal(isFinalVideoFilename('', '_final_video.mp4'), false)
  })
})
