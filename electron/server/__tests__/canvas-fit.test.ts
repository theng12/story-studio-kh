import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canvasFitChain } from '../services/episode-timeline-render.js'

// Owner 2026-11-19: the 1344x768 option is 7:4, 1.6% narrower than 16:9. It must be centre-cropped to
// the frame — never stretched, never letterboxed — while video keeps its contain-and-pad behaviour.
test('a picture covers the frame; video is contained and padded', () => {
  const still = canvasFitChain(1920, 1080, 'still')
  assert.match(still, /force_original_aspect_ratio=increase/)
  assert.match(still, /crop=1920:1080$/)
  assert.doesNotMatch(still, /pad=/)

  const video = canvasFitChain(1920, 1080, 'video')
  assert.match(video, /force_original_aspect_ratio=decrease/)
  assert.match(video, /pad=1920:1080/)
  assert.doesNotMatch(video, /crop=/)
})
