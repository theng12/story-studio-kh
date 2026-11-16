/**
 * Branded typography — the pool, the last-N guard and OFF compatibility (2026-11-16).
 *
 * The accent pool is independent of the 10-member format cap; N must not exceed accents-1, and a
 * pinned choice is a human pick rather than a hash fallback. The renderer accent layer must draw
 * nothing when absent or disabled, so every existing thumbnail and still post stays byte-identical.
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

import {
  BRANDED_TYPOGRAPHY_DEFAULTS,
  BrandedTypographySchema,
  eligibleAccents,
  pickBrandedAccent,
  type BrandedAccent,
} from '../contracts/branded-typography.js'
import { renderThumbnailText } from '../lib/thumbnail-text-render.js'
import { THUMBNAIL_TEXT_CANVAS } from '../contracts/thumbnail-text.js'
import type { ThumbnailTextStyle } from '../contracts/thumbnail-text.js'

const accent = (id: string, over: Partial<BrandedAccent> = {}): BrandedAccent => ({
  id, label: id, file: `${id}.png`, sha256: 'a'.repeat(64), width: 200, height: 80, has_alpha: true, ...over,
})

const LIVE = [accent('a'), accent('b'), accent('c')]

test('the default is OFF and an empty pool is a valid state', () => {
  assert.equal(BRANDED_TYPOGRAPHY_DEFAULTS.enabled, false)
  assert.equal(BrandedTypographySchema.safeParse(BRANDED_TYPOGRAPHY_DEFAULTS).success, true)
})

test('the last-N window excludes those accents and wraps only when it must', () => {
  assert.deepEqual(eligibleAccents(LIVE, ['a'], 3).eligible.map(a => a.id), ['b', 'c'])
  assert.deepEqual(eligibleAccents(LIVE, ['a', 'b', 'c'], 3).eligible.map(a => a.id), ['a', 'b', 'c'],
    'the guard never excludes the whole pool')
  assert.equal(eligibleAccents(LIVE, ['a', 'b', 'c'], 3).wrapped, true)
  assert.equal(eligibleAccents(LIVE, ['a'], 1).eligible.length, 3, 'N=1 disables the guard')
})

test('the pick is deterministic, never inside the window, and a pinned choice wins', () => {
  const first = pickBrandedAccent('EP0012', LIVE, ['a'], 3)
  const again = pickBrandedAccent('EP0012', LIVE, ['a'], 3)
  assert.deepEqual(first, again)
  assert.notEqual(first!.accent.id, 'a', 'an accent used in the window is not picked')
  const pinned = pickBrandedAccent('EP0012', LIVE, ['a'], 3, 'a')
  assert.equal(pinned!.accent.id, 'a')
  assert.equal(pinned!.source, 'pinned', 'a human pick is recorded as pinned, not pooled')
})

test('a retired accent is not in the pool', () => {
  const pool = [accent('a', { retired_at: '2026-11-16T00:00:00Z' }), accent('b')]
  assert.deepEqual(eligibleAccents(pool, [], 3).eligible.map(a => a.id), ['b'])
})

// ── Renderer: the accent layer is opt-in and byte-identical when absent ─────

let sourcePng: Buffer
let accentPng: string

function style(): ThumbnailTextStyle {
  return {
    font_id: 'kantumruy-pro', weight: 700,
    size: { mode: 'fit', min_px: 28, max_px: 116 }, max_lines: 2, align: 'left',
    line_height: 1.12, letter_spacing: 0, uppercase: false,
    fill: { type: 'solid', color: '#FFD60A' }, opacity: 1,
    outline: { enabled: false, color: '#000000', width_px: 0 },
    shadow: { enabled: false, color: '#000000', opacity: 0.5, dx: 0, dy: 4, blur_px: 6 },
    background: { enabled: false, color: '#000000', opacity: 0.5, padding_px: 20, radius_px: 12 },
    placement: { anchor: 'bottom-left', x_pct: 5, y_pct: 93, width_pct: 72, height_pct: 32 },
  }
}

before(async () => {
  sourcePng = await sharp({
    create: { width: THUMBNAIL_TEXT_CANVAS.width, height: THUMBNAIL_TEXT_CANVAS.height, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } },
  }).png().toBuffer()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'branded-accent-'))
  accentPng = path.join(dir, 'badge.png')
  await sharp({
    create: { width: 200, height: 80, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } },
  }).png().toFile(accentPng)
})

test('no accent, disabled accent and absent branding render the same bytes', async () => {
  const plain = await renderThumbnailText({ sourceBytes: sourcePng, text: 'Headline', style: style() })
  const disabled = await renderThumbnailText({
    sourceBytes: sourcePng, text: 'Headline', style: style(),
    branding: {
      handle: { enabled: false, text: '', font_id: 'kantumruy-pro', weight: 400, size_px: 20, color: '#ffffff', opacity: 1 },
      logo: { enabled: false, path: null, width_pct: 10, opacity: 1 },
      position: 'bottom-left', margin_pct: 3,
      accent: { enabled: false, path: null, width_pct: 12, opacity: 1, anchor: 'bottom-right', margin_pct: 3 },
    },
  })
  assert.equal(disabled.png.toString('base64'), plain.png.toString('base64'),
    'OFF must be byte-identical')
})

test('an enabled accent draws on its own corner', async () => {
  const plain = await renderThumbnailText({ sourceBytes: sourcePng, text: 'Headline', style: style() })
  const withAccent = await renderThumbnailText({
    sourceBytes: sourcePng, text: 'Headline', style: style(),
    branding: {
      handle: { enabled: false, text: '', font_id: 'kantumruy-pro', weight: 400, size_px: 20, color: '#ffffff', opacity: 1 },
      logo: { enabled: false, path: null, width_pct: 10, opacity: 1 },
      position: 'bottom-left', margin_pct: 3,
      accent: { enabled: true, path: accentPng, width_pct: 12, opacity: 1, anchor: 'bottom-right', margin_pct: 3 },
    },
  })
  assert.notEqual(withAccent.png.toString('base64'), plain.png.toString('base64'))
  const { data, info } = await sharp(withAccent.png).raw().toBuffer({ resolveWithObject: true })
  // Inside the accent box: margin 3% of the canvas, the accent sits just past it.
  const inset = Math.round(info.width * 0.03) + 10
  const x = info.width - inset
  const y = info.height - inset
  const offset = (y * info.width + x) * info.channels
  assert.ok(data[offset]! > 150 && data[offset + 1]! < 90, `bottom-right pixel is the red accent, got ${data[offset]},${data[offset + 1]}`)
})
