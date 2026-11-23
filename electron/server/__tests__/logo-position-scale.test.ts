/**
 * A custom logo X/Y is typed on the 1920×1080 preview. the channel saved x=1650,
 * y=80 and renders at 720p, where that put the logo past the right edge of a
 * 1280-wide frame. It now scales to the canvas and stays on it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scaleAuthoredPosition, calculateLogoPosition } from '../lib/video-effects.js'
import { buildFinalLogoFilters } from '../lib/final-render-core.js'
import type { VideoLogoConfig } from '../models/types.js'

const channelLogo: VideoLogoConfig = {
  enabled: true,
  image_path: '/tmp/terra-nash-logo.png',
  position: 'custom',
  custom_x: 1650,
  custom_y: 80,
  opacity: 1,
  scale: 0.08,
  margin: 50,
  hide_during_intro: false,
}

test('the channel x=1650,y=80 lands where the preview shows it, at 720p and 1080p', () => {
  // 720p: logo is 8 % of 1280 = 102 px wide.
  assert.deepEqual(calculateLogoPosition('custom', 50, scaleAuthoredPosition(1650, 1280, 1920, 102), scaleAuthoredPosition(80, 720, 1080)), { x: '1100', y: '53' })
  assert.deepEqual(calculateLogoPosition('custom', 50, scaleAuthoredPosition(1650, 1920, 1920, 154), scaleAuthoredPosition(80, 1080, 1080)), { x: '1650', y: '80' }, '1080p unchanged')
})

test('a position past the edge is kept on the canvas; no custom value stays undefined', () => {
  assert.equal(scaleAuthoredPosition(1900, 1920, 1920, 154), 1766)
  assert.equal(scaleAuthoredPosition(-20, 1280, 1920, 102), 0)
  assert.equal(scaleAuthoredPosition(undefined, 1280, 1920), undefined)
  assert.deepEqual(calculateLogoPosition('custom', 20, scaleAuthoredPosition(undefined, 1280, 1920), 10), calculateLogoPosition('custom', 20), 'falls back to the anchor like before')
})

test('the render passes the scaled values', async () => {
  // The final-render graph (the logo filter included) moved to lib/final-render-core.ts in 1.4.347;
  // generators/video.ts now calls it. The scaled values are unchanged, so the render is what proves it.
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'final-render-core.ts'), 'utf8')
  assert.match(source, /scaleAuthoredPosition\(logo\.custom_x, w, 1920, logoW\), scaleAuthoredPosition\(logo\.custom_y, h, 1080\)/)

  const at720 = buildFinalLogoFilters({ input: '[v0]', allocLabel: () => '[v1]' }, channelLogo, 3, 1280, 720, '')
  assert.deepEqual(at720.filters, [
    '[3:v]scale=102:-1,format=rgba,colorchannelmixer=aa=1[logo]',
    '[v0][logo]overlay=1100:53[v1]',
  ], '720p: the logo is 8 % of 1280 and lands at the scaled position')
  const at1080 = buildFinalLogoFilters({ input: '[v0]', allocLabel: () => '[v1]' }, channelLogo, 3, 1920, 1080, '')
  assert.deepEqual(at1080.filters, [
    '[3:v]scale=154:-1,format=rgba,colorchannelmixer=aa=1[logo]',
    '[v0][logo]overlay=1650:80[v1]',
  ], '1080p: the authored position is unchanged')
})
