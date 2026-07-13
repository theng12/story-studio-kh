/**
 * Tests for the shared FFmpeg frame-normalisation helper.
 *
 * Pins the `setsar=1,pad=…` construction that every video clip (scene,
 * intro, post-audio fade/hold/black) flows through. Historical bug: on
 * FFmpeg 8.1 the parser misread `pad=…:color=black,setsar=1` as if
 * `setsar` were a pad option (because the trailing color value greedily
 * consumed the next token). The fix in animation-filters.ts hoists
 * `setsar=1` ABOVE `pad=…` so the two filters are never adjacent in
 * that order. These tests pin that invariant — if someone ever swaps
 * the order back, long-episode renders will explode and these fail
 * first.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnimationFilter, normalizeFrame } from '../lib/animation-filters.js'

describe('normalizeFrame()', () => {
  test('emits exactly the five FFmpeg filter tokens in the expected order', () => {
    const tokens = normalizeFrame(1920, 1080, 30)
    // Order matters: setsar must come BEFORE pad to dodge the FFmpeg 8.1
    // pad-options-eat-setsar bug. See animation-filters.ts:42 for the
    // full backstory.
    assert.deepEqual(tokens, [
      'scale=1920:1080:force_original_aspect_ratio=decrease',
      'setsar=1',
      'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black',
      'fps=30',
      'format=yuv420p',
    ])
  })

  test('joins to a comma-separated filter string that FFmpeg 8.1 accepts', () => {
    const joined = normalizeFrame(1280, 720, 60).join(',')
    // The load-bearing substring: `setsar=1,pad=…` — `pad,setsar` is what
    // FFmpeg 8.1 mis-parses, so we put setsar first instead.
    assert.match(joined, /setsar=1,pad=1280:720:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black/,
      'setsar must precede pad and be comma-separated, not colon-attached')
    assert.ok(!joined.includes(':setsar='),
      'no `:setsar=` substring may appear — that was the FFmpeg 8.1 crash pattern')
    assert.ok(!/color=black,setsar=1/.test(joined),
      'pad must not be immediately followed by setsar — that adjacency triggers the crash')
  })

  test('honours dynamic width / height / fps', () => {
    const tokens = normalizeFrame(3840, 2160, 24)
    assert.ok(tokens[0].startsWith('scale=3840:2160'))
    assert.equal(tokens[1], 'setsar=1')
    assert.ok(tokens[2].startsWith('pad=3840:2160'))
    assert.equal(tokens[3], 'fps=24')
  })

  test('last token is format=yuv420p so x264 gets the right pixel format', () => {
    const tokens = normalizeFrame(1920, 1080, 30)
    assert.equal(tokens[tokens.length - 1], 'format=yuv420p',
      'format must be the final token so per-scene filter insertions can splice before it')
  })
})

describe('zoompan supersampling', () => {
  test('keeps camera motion at 2x resolution until one final Lanczos downscale', () => {
    const tokens = buildAnimationFilter({
      type: 'ken-burns', w: 1920, h: 1080, fps: 30, duration: 8,
      params: {
        type: 'ken-burns', zoom_start: 100, zoom_end: 108,
        parallax_direction: 'right', parallax_speed: 2,
        breathe_amplitude: 2, breathe_base_zoom: 103,
      },
    })
    assert.match(tokens.join(','), /zoompan=.*:s=3840x2160:fps=30/)
    assert.ok(tokens.includes('scale=1920:1080:flags=lanczos'))
    assert.doesNotMatch(tokens.join(','), /zoompan=.*:s=1920x1080/)
  })
})
