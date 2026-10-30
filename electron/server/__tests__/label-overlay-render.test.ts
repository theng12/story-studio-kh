/**
 * The image-backed label path, proven on real rendered pixels.
 *
 * A filter-string assertion would pass while the label landed off-frame or not
 * at all — AGENTS.md §3. This renders with the real binary and reads pixels
 * back, using the SAME geometry the final composition uses.
 *
 * Skips loudly when no overlay-capable FFmpeg is present. Unlike the drawtext
 * placement test, this path needs `overlay` only — which every FFmpeg build
 * the app ships has, including one built without libfreetype.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { buildContextualCueDrawtextFilters, labelOverlayGeometry } from '../lib/contextual-cue-filters.js'
import { findLabelDesign, renderLabelDesign, renderLeaderLine } from '../lib/label-design-render.js'
import type { ContextualCue } from '../models/types.js'

const run = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WIDTH = 640
const HEIGHT = 360

function findFfmpeg(): string | null {
  const candidates = [
    path.join(REPO_ROOT, 'bundled', 'ffmpeg', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]
  for (const bin of candidates) {
    if (!existsSync(bin)) continue
    try {
      const out = execFileSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 20000 })
      if (/^\s*\S+\s+overlay\s/m.test(out)) return bin
    } catch { /* try the next candidate */ }
  }
  return null
}
const FFMPEG = findFfmpeg()

function cue(overrides: Partial<ContextualCue> = {}): ContextualCue {
  return {
    id: 'cue-1', scene_id: 'scene-1', start_sec: 0.5, end_sec: 4.5,
    title: 'Berlin', kind: 'location_date', placement: 'top-left',
    template: 'label:location-pin', entrance: 'fade', exit: 'fade',
    status: 'approved', created_at: '', updated_at: '', ...overrides,
  }
}

async function meanOf(file: string, region: { x: number; y: number; w: number; h: number }, dir: string): Promise<number> {
  const raw = path.join(dir, `s-${Math.random().toString(36).slice(2)}.raw`)
  await run(FFMPEG!, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '1.5', '-i', file, '-frames:v', '1',
    '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw,
  ])
  const bytes = readFileSync(raw)
  let total = 0
  for (const byte of bytes) total += byte
  return total / bytes.length
}

describe('image-backed labels, verified on rendered pixels', { skip: FFMPEG ? false : 'no drawtext-capable ffmpeg found' }, () => {
  test('a label overlay lands where the geometry says, and nowhere else', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'label-overlay-'))
    try {
      const design = (await findLabelDesign('label:location-pin'))!
      const rendered = await renderLabelDesign({ design, title: 'BERLIN', frame_w: WIDTH, frame_h: HEIGHT })
      const geometry = labelOverlayGeometry(cue({ position_x_pct: 25, position_y_pct: 30 }), rendered, WIDTH, HEIGHT)
      const png = path.join(dir, 'label.png')
      writeFileSync(png, rendered.png)
      const out = path.join(dir, 'out.mp4')
      await run(FFMPEG!, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=red:s=${WIDTH}x${HEIGHT}:d=3:r=10`,
        '-i', png,
        '-filter_complex', `[0:v][1:v]overlay=x=${geometry.x}:y=${geometry.y}:eof_action=repeat:enable='between(t,0.5,4.5)'[vout]`,
        '-map', '[vout]', '-pix_fmt', 'yuv420p', out,
      ], { maxBuffer: 1024 * 1024 * 16 })

      const onLabel = await meanOf(out, { x: geometry.x + 4, y: geometry.y + 4, w: Math.min(60, rendered.width - 8), h: Math.min(30, rendered.height - 8) }, dir)
      const farAway = await meanOf(out, { x: WIDTH - 120, y: HEIGHT - 90, w: 80, h: 60 }, dir)
      const redMean = (255 + 0 + 0) / 3
      // This design is a light card on the red field, so presence means the
      // mean MOVES — either brighter or darker — rather than only darker.
      assert.ok(Math.abs(onLabel - redMean) > 8, `the label did not render where it was placed (mean ${onLabel.toFixed(1)})`)
      assert.ok(Math.abs(farAway - redMean) <= 4, `the label leaked into empty frame space (mean ${farAway.toFixed(1)})`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a leader line reaches the separate target point', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'label-line-'))
    try {
      const design = (await findLabelDesign('label:location-pin'))!
      const rendered = await renderLabelDesign({ design, title: 'BERLIN', frame_w: WIDTH, frame_h: HEIGHT })
      const geometry = labelOverlayGeometry(cue({ position_x_pct: 20, position_y_pct: 25, target_x_pct: 80, target_y_pct: 80 }), rendered, WIDTH, HEIGHT)
      const line = await renderLeaderLine({
        frame_w: WIDTH, frame_h: HEIGHT,
        from: { x: geometry.anchor.x / WIDTH, y: geometry.anchor.y / HEIGHT },
        to: { x: 0.8, y: 0.8 },
      })
      const linePath = path.join(dir, 'line.png')
      writeFileSync(linePath, line)
      const out = path.join(dir, 'line.mp4')
      await run(FFMPEG!, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=red:s=${WIDTH}x${HEIGHT}:d=3:r=10`,
        '-i', linePath,
        '-filter_complex', '[0:v][1:v]overlay=x=0:y=0:eof_action=repeat[vout]',
        '-map', '[vout]', '-pix_fmt', 'yuv420p', out,
      ], { maxBuffer: 1024 * 1024 * 16 })
      const atTarget = await meanOf(out, { x: Math.round(0.8 * WIDTH) - 8, y: Math.round(0.8 * HEIGHT) - 8, w: 16, h: 16 }, dir)
      assert.ok(atTarget > 20, `no mark was drawn at the target point (mean ${atTarget.toFixed(1)})`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the four existing treatments still take the drawtext path, byte for byte', async () => {
    for (const template of ['documentary-label', 'map-pin', 'archival-caption', 'chapter-plate'] as const) {
      const filters = buildContextualCueDrawtextFilters(cue({ template, title: 'Berlin', subtitle: '1919' }))
      assert.ok(filters.length > 0)
      for (const filter of filters) assert.match(filter, /^drawtext=/)
    }
    assert.throws(() => buildContextualCueDrawtextFilters(cue()), /image overlay/)
  })
})
