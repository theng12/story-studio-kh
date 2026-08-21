/**
 * The render canvas — resolution × aspect ratio (v1.4.15).
 *
 * The first block is the one that matters most: it pins that every canvas that
 * existed before this release comes out of the new derivation byte-identical.
 * The four hardcoded pairs were deleted, and this is the evidence that deleting
 * them changed nothing about any render already delivered.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASPECT_MISMATCH_THRESHOLD,
  aspectDivergence,
  canvasForShortEdge,
  describeAspectRatio,
  displayAspectRatio,
  frameTextUnit,
  isSupportedAspectRatio,
  parseAspectRatio,
  resolveRenderCanvas,
} from '../lib/render-canvas.js'

describe('render canvas', () => {
  test('every 16:9 canvas is exactly what the deleted table held', () => {
    // Left column: what `RESOLUTIONS` in generators/video.ts contained until
    // v1.4.15. If any of these move, a project re-rendered after upgrading
    // would not match the file it replaced.
    const before: Record<string, [number, number]> = {
      '720p': [1280, 720],
      '1080p': [1920, 1080],
      '1440p': [2560, 1440],
      '4k': [3840, 2160],
    }
    for (const [tier, [w, h]] of Object.entries(before)) {
      assert.deepEqual(resolveRenderCanvas(tier, '16:9'), { w, h }, `${tier} 16:9`)
      // And with no ratio at all — every preset saved before this release.
      assert.deepEqual(resolveRenderCanvas(tier), { w, h }, `${tier} default`)
    }
  })

  test('portrait swaps the edges rather than shrinking the picture', () => {
    assert.deepEqual(resolveRenderCanvas('1080p', '9:16'), { w: 1080, h: 1920 })
    assert.deepEqual(resolveRenderCanvas('720p', '9:16'), { w: 720, h: 1280 })
    assert.deepEqual(resolveRenderCanvas('4k', '9:16'), { w: 2160, h: 3840 })
  })

  test('square is square at every tier', () => {
    assert.deepEqual(resolveRenderCanvas('1080p', '1:1'), { w: 1080, h: 1080 })
    assert.deepEqual(resolveRenderCanvas('4k', '1:1'), { w: 2160, h: 2160 })
  })

  test('a ratio nobody listed still renders — the engine parses, it does not match', () => {
    assert.deepEqual(resolveRenderCanvas('1080p', '4:5'), { w: 1080, h: 1350 })
    assert.deepEqual(resolveRenderCanvas('1080p', '21:9'), { w: 2520, h: 1080 })
    assert.deepEqual(resolveRenderCanvas('1080p', '2.35:1'), { w: 2538, h: 1080 })
  })

  test('every edge is even, whatever the ratio', () => {
    for (const tier of ['720p', '1080p', '1440p', '4k']) {
      for (const ratio of ['16:9', '9:16', '1:1', '4:5', '21:9', '2.35:1', '1.85:1', '3:2']) {
        const { w, h } = resolveRenderCanvas(tier, ratio)
        assert.equal(w % 2, 0, `${tier} ${ratio} width`)
        assert.equal(h % 2, 0, `${tier} ${ratio} height`)
      }
    }
  })

  test('nonsense falls back rather than failing a render', () => {
    assert.deepEqual(resolveRenderCanvas('1080p', 'wide'), { w: 1920, h: 1080 })
    assert.deepEqual(resolveRenderCanvas('1080p', '0:0'), { w: 1920, h: 1080 })
    assert.deepEqual(resolveRenderCanvas('1080p', '-4:3'), { w: 1920, h: 1080 })
    assert.deepEqual(resolveRenderCanvas('8k', '16:9'), { w: 1920, h: 1080 })
  })

  test('the shapes a person might reasonably type all parse', () => {
    for (const written of ['16:9', '16x9', '16/9', ' 16 : 9 ']) {
      assert.deepEqual(parseAspectRatio(written), { w: 16, h: 9 }, written)
    }
    assert.equal(parseAspectRatio('1.85:1')!.w, 1.85)
    assert.equal(isSupportedAspectRatio('9:16'), true)
    assert.equal(isSupportedAspectRatio('portrait'), false)
    assert.equal(isSupportedAspectRatio(undefined), false)
  })
})

describe('frame text unit', () => {
  test('is the height on every landscape canvas, so nothing shipped moves', () => {
    for (const tier of ['720p', '1080p', '1440p', '4k']) {
      const { w, h } = resolveRenderCanvas(tier, '16:9')
      assert.equal(frameTextUnit(w, h), h, tier)
    }
  })

  test('is the WIDTH in portrait — the whole point of the change', () => {
    const { w, h } = resolveRenderCanvas('1080p', '9:16')
    assert.equal(frameTextUnit(w, h), 1080)
    // Sizing against the height instead would have made a "medium" chapter
    // title 107px wide-ish glyphs on a 1080px frame.
    assert.equal(Math.round(h / 18), 107)
    assert.equal(Math.round(frameTextUnit(w, h) / 18), 60)
  })
})

describe('describing and comparing shapes', () => {
  test('pixel dimensions reduce to the ratio a person would name', () => {
    assert.equal(describeAspectRatio(1920, 1080), '16:9')
    assert.equal(describeAspectRatio(1080, 1920), '9:16')
    assert.equal(describeAspectRatio(1024, 1024), '1:1')
    assert.equal(describeAspectRatio(1080, 1350), '4:5')
    assert.equal(describeAspectRatio(0, 100), '')
  })

  test('but the shape is CALLED what he chose to call it', () => {
    // 21:9 reduces to 7:3, which is the same ratio under a name nobody asked
    // for — sitting in a label right beside a picker that says 21:9.
    assert.equal(describeAspectRatio(2520, 1080), '7:3')
    assert.equal(displayAspectRatio('21:9', 2520, 1080), '21:9')
    assert.equal(displayAspectRatio('9:16', 1080, 1920), '9:16')
    // Nothing chosen (every preset saved before this release) falls back.
    assert.equal(displayAspectRatio(undefined, 1920, 1080), '16:9')
    assert.equal(displayAspectRatio('nonsense', 1920, 1080), '16:9')
  })

  test('the mismatch threshold separates a near-miss from a black bar', () => {
    const wide = 1920 / 1080
    const tall = 1080 / 1920
    // A portrait render of landscape stills: flagged, loudly.
    assert.ok(aspectDivergence(wide, tall) > ASPECT_MISMATCH_THRESHOLD)
    // Cinematic sources into a 16:9 frame: a crop, not a catastrophe. Silent.
    assert.ok(aspectDivergence(1.85, wide) < ASPECT_MISMATCH_THRESHOLD)
    // 1344×768, what the image presets actually produce for "16:9": silent.
    assert.ok(aspectDivergence(1344 / 768, wide) < ASPECT_MISMATCH_THRESHOLD)
    // 4:3 into 16:9: a quarter of the frame would be bar. Flagged.
    assert.ok(aspectDivergence(4 / 3, wide) > ASPECT_MISMATCH_THRESHOLD)
  })
})

describe('preview canvases', () => {
  test('the short-edge form reproduces the sizes the previews always used', () => {
    // 480×270 (transition / animation / effect pickers) and 1280×720
    // (subtitle style preview) — both 16:9, both unchanged.
    assert.deepEqual(canvasForShortEdge(270, '16:9'), { w: 480, h: 270 })
    assert.deepEqual(canvasForShortEdge(720, '16:9'), { w: 1280, h: 720 })
    assert.deepEqual(canvasForShortEdge(270), { w: 480, h: 270 })
  })

  test('and follow the ratio when there is one', () => {
    assert.deepEqual(canvasForShortEdge(270, '9:16'), { w: 270, h: 480 })
    assert.deepEqual(canvasForShortEdge(720, '1:1'), { w: 720, h: 720 })
  })
})
