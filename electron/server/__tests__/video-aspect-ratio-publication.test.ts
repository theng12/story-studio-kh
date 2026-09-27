/**
 * The aspect ratio a video request carries comes from the PUBLISHED variant.
 *
 * Measured defect, 2026-09-27: Story Studio hardcoded `16:9` (or `9:16` for a
 * portrait request) and sent it with a resolution the user picked from the
 * published variant list. Against a Studio Hub video lane that is now a broken
 * request: the lane's canvases are PAIRS on the pack's 64-px grid, its 448p class
 * carries 704x448 (11:7) and 448x448 (1:1), and 16:9 at that class does not
 * exist. The lane refused the job — and the one canvas it did accept for 16:9 was
 * the canvas the pack floors to 2:1, so the clip that came back was a different
 * shape than the label on it.
 *
 * The rule these tests pin: send the ratio the resolved variant itself publishes;
 * where a product publishes none per variant, read its published `aspect_ratios`
 * for the requested orientation; where it publishes none at all, send nothing and
 * let the lane decide.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { aspectRatioForResolvedVariant } from '../providers/video/genstudio.js'

const variant = (extra: Record<string, unknown> = {}) => ({
  operation: 'image-to-video',
  duration_seconds: 4,
  resolution: '448p',
  credits_per_video: 0,
  minimum_credits: 0,
  price_version: 'flat',
  ...extra,
})

test('the variant\'s own published ratio is what is sent', () => {
  assert.equal(
    aspectRatioForResolvedVariant(
      { variant: variant({ aspect_ratio: '11:7' }), publishedAspectRatios: ['11:7', '1:1'], controls: [] },
      false,
    ),
    '11:7',
  )
  assert.equal(
    aspectRatioForResolvedVariant(
      { variant: variant({ aspect_ratio: '4:7' }), publishedAspectRatios: ['7:4', '4:7'], controls: [] },
      true,
    ),
    '4:7',
    'a portrait request gets the portrait canvas the variant states, not a hardcoded 9:16',
  )
})

test('a product with no per-variant ratio is read from its published ratio list', () => {
  // Every cloud video lane. The list is GenStudio's, so choosing from it is reading
  // published data — the old hardcoded pair happened to match this list and would not
  // have matched a product that publishes only 1:1.
  const cloud = { variant: variant({ resolution: '720p' }), publishedAspectRatios: ['16:9', '9:16', '1:1'], controls: [] }
  assert.equal(aspectRatioForResolvedVariant(cloud, false), '16:9')
  assert.equal(aspectRatioForResolvedVariant(cloud, true), '9:16')

  const squareOnly = { variant: variant({ resolution: '1024' }), publishedAspectRatios: ['1:1'], controls: [] }
  assert.equal(aspectRatioForResolvedVariant(squareOnly, false), '1:1')
  assert.equal(
    aspectRatioForResolvedVariant(squareOnly, true),
    undefined,
    'a product with no portrait ratio gets no invented 9:16 — the request omits the field and '
    + 'the lane\'s own default decides, because the lane is the one that knows its canvases',
  )
})

test('nothing published means no aspect_ratio field, never a guess', () => {
  assert.equal(
    aspectRatioForResolvedVariant({ variant: variant(), publishedAspectRatios: [], controls: [] }, false),
    undefined,
  )
  assert.equal(
    aspectRatioForResolvedVariant({ variant: variant(), publishedAspectRatios: [], controls: [] }, true),
    undefined,
    'the lane\'s own default decides; Story Studio does not invent 16:9/9:16 for it',
  )
})

test('an unparseable published ratio is ignored rather than treated as landscape', () => {
  assert.equal(
    aspectRatioForResolvedVariant(
      { variant: variant(), publishedAspectRatios: ['wide', '9:16'], controls: [] },
      true,
    ),
    '9:16',
    '"wide" is not a ratio this reader understands, so the portrait one is still found',
  )
  assert.equal(
    aspectRatioForResolvedVariant({ variant: variant(), publishedAspectRatios: ['wide'], controls: [] }, false),
    undefined,
  )
})
