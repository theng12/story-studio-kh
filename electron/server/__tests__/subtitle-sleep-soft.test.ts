/**
 * Sleep Soft must stay readable at 1080p (Dreamlands E2E 2026-10-03: 24 px,
 * 82 % grey with a 1 px / 55 % outline was nearly unreadable over bright scenes).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'

test('Sleep Soft is soft in tint and motion, not in size or contrast', () => {
  const style = BUILT_IN_SUBTITLE_PRESETS.find(p => p.id === 'sleep-soft')!.style
  assert.ok(style.typography.font_size_px >= 28, `font ${style.typography.font_size_px}px`)
  assert.ok(style.color.primary_opacity >= 0.9, `text opacity ${style.color.primary_opacity}`)
  assert.ok(style.edge.outline_px >= 2 && style.color.outline_opacity >= 0.8, 'needs a firm outline')
  assert.equal(style.animation.type, 'fade')
})
