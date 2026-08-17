/**
 * Where a contextual cue actually lands, proven on rendered pixels (v1.3.0).
 *
 * Why this exists rather than another filter-string assertion:
 *
 * Before v1.3.0 the cue placement type declared four corners, the timeline
 * validator accepted four, and the renderer computed all four correctly — and
 * a customer still could not put a label anywhere except the two top corners,
 * because six other places quietly collapsed the value on its way through. A
 * unit test on a filter string would have passed throughout. AGENTS.md calls
 * this class out directly: "Every automated gate can be green while the app is
 * visibly broken."
 *
 * So this test renders real video with the real binary and reads the actual
 * pixels back. It answers two questions no string comparison can:
 *
 *   1. Does a label placed bottom-left appear in the BOTTOM LEFT of the frame,
 *      and nowhere else?
 *   2. Does it stay on screen for the whole window it was given, and vanish
 *      outside it?
 *
 * The background is deliberately saturated red and every cue draws a dark
 * navy box, so "is there a label in this region" is a brightness question with
 * an unambiguous answer rather than a judgement call.
 *
 * Skips loudly when no drawtext-capable FFmpeg is present, matching
 * `ffmpeg-filter-escape.test.ts` — `bundled/ffmpeg/` is gitignored.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildContextualCueDrawtextFilters } from '../lib/contextual-cue-filters.js'
import { CONTEXTUAL_CUE_CORNERS, type ContextualCueCorner } from '../contracts/contextual-cue-position.js'
import type { ContextualCue } from '../models/types.js'

const run = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const WIDTH = 640
const HEIGHT = 360

function findDrawtextFfmpeg(): string | null {
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
      if (/^\s*\S+\s+drawtext\s/m.test(out)) return bin
    } catch { /* try the next candidate */ }
  }
  return null
}

const FFMPEG = findDrawtextFfmpeg()

function cue(overrides: Partial<ContextualCue> = {}): ContextualCue {
  return {
    id: 'cue-1',
    scene_id: 'scene-1',
    start_sec: 1,
    end_sec: 4,
    title: 'BERLIN',
    kind: 'location_date',
    placement: 'top-right',
    template: 'documentary-label',
    entrance: 'fade',
    exit: 'fade',
    status: 'approved',
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

/**
 * The five regions this test reasons about. Each is a generous rectangle that
 * fully contains a label anchored to that spot but does not overlap any other
 * region, so "present here" and "absent there" are both decidable.
 */
const REGIONS = {
  'top-left': { x: 0, y: 0, w: 210, h: 95 },
  'top-right': { x: 430, y: 0, w: 210, h: 95 },
  'bottom-left': { x: 0, y: 265, w: 210, h: 95 },
  'bottom-right': { x: 430, y: 265, w: 210, h: 95 },
  centre: { x: 215, y: 130, w: 210, h: 100 },
} as const
type RegionName = keyof typeof REGIONS

/**
 * Mean RGB of one region of one frame. Cropping to rawvideo and averaging is
 * the same sampling idiom `scene-effect-preview-render.test.ts` already uses.
 */
async function sampleRegion(file: string, atSeconds: number, region: { x: number; y: number; w: number; h: number }, dir: string): Promise<number> {
  const raw = path.join(dir, `sample-${atSeconds}-${region.x}-${region.y}.raw`)
  await run(FFMPEG!, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(atSeconds), '-i', file, '-frames:v', '1',
    '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw,
  ])
  const bytes = readFileSync(raw)
  let total = 0
  for (const byte of bytes) total += byte
  return total / bytes.length
}

/**
 * A label is present when its dark navy box has pulled the region's mean well
 * below the bare red background. The two are far apart — background red
 * averages ~85 across RGB, a boxed label drags its region into the 50s or
 * lower — so the threshold is not delicate.
 */
const BACKGROUND_MEAN = (255 + 0 + 0) / 3
function labelPresent(mean: number): boolean {
  return mean < BACKGROUND_MEAN - 8
}

async function renderWithCues(cues: ContextualCue[], durationSec: number, dir: string): Promise<string> {
  const out = path.join(dir, `render-${Math.random().toString(36).slice(2)}.mp4`)
  const filters = cues.flatMap(c => buildContextualCueDrawtextFilters(c))
  await run(FFMPEG!, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=${WIDTH}x${HEIGHT}:d=${durationSec}:r=10`,
    '-vf', filters.join(','),
    '-pix_fmt', 'yuv420p', out,
  ], { maxBuffer: 1024 * 1024 * 16 })
  return out
}

describe('contextual cue placement, verified on rendered pixels', { skip: FFMPEG ? false : 'no drawtext-capable ffmpeg found (run npm run fetch:ffmpeg)' }, () => {
  test('each of the four corners draws its label in that corner and nowhere else', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cue-placement-'))
    try {
      for (const corner of CONTEXTUAL_CUE_CORNERS) {
        const file = await renderWithCues([cue({ placement: corner })], 5, dir)
        const means: Record<string, number> = {}
        for (const [name, region] of Object.entries(REGIONS)) {
          means[name] = await sampleRegion(file, 2.5, region, dir)
        }
        assert.ok(
          labelPresent(means[corner]!),
          `a ${corner} cue did not render in the ${corner} region (mean ${means[corner]!.toFixed(1)}, background ${BACKGROUND_MEAN.toFixed(1)})`,
        )
        for (const other of CONTEXTUAL_CUE_CORNERS) {
          if (other === corner) continue
          assert.ok(
            !labelPresent(means[other]!),
            `a ${corner} cue also painted the ${other} region (mean ${means[other]!.toFixed(1)})`,
          )
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a precise anchor puts the label where it was placed, clear of every corner', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cue-custom-'))
    try {
      // Dead centre — the one place no corner preset can reach, and the shape
      // of what the customer asked for: "somewhere that is not over my logo".
      const file = await renderWithCues([cue({ position_x_pct: 50, position_y_pct: 50 })], 5, dir)
      const centre = await sampleRegion(file, 2.5, REGIONS.centre, dir)
      assert.ok(labelPresent(centre), `a centred cue did not render in the centre (mean ${centre.toFixed(1)})`)
      for (const corner of CONTEXTUAL_CUE_CORNERS) {
        const mean = await sampleRegion(file, 2.5, REGIONS[corner], dir)
        assert.ok(!labelPresent(mean), `a centred cue leaked into the ${corner} region (mean ${mean.toFixed(1)})`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a precise anchor overrides the corner it still carries', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cue-override-'))
    try {
      // Stored placement says top-right; the precise anchor says bottom-left.
      // The anchor must win, or a dragged cue would snap back on save.
      const file = await renderWithCues([cue({ placement: 'top-right', position_x_pct: 12, position_y_pct: 88 })], 5, dir)
      const bottomLeft = await sampleRegion(file, 2.5, REGIONS['bottom-left'], dir)
      const topRight = await sampleRegion(file, 2.5, REGIONS['top-right'], dir)
      assert.ok(labelPresent(bottomLeft), `the precise anchor was ignored (bottom-left mean ${bottomLeft.toFixed(1)})`)
      assert.ok(!labelPresent(topRight), `the stored corner won over the precise anchor (top-right mean ${topRight.toFixed(1)})`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a cue holds for its whole window and is gone outside it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cue-window-'))
    try {
      // 9 seconds — twice the 4.5s ceiling this release removed. Under the old
      // rule this exact cue was refused outright; it must now render, and hold
      // for every second it was given.
      const file = await renderWithCues([cue({ placement: 'bottom-left', start_sec: 2, end_sec: 11 })], 13, dir)
      const region = REGIONS['bottom-left']
      const before = await sampleRegion(file, 1.0, region, dir)
      const after = await sampleRegion(file, 12.0, region, dir)
      assert.ok(!labelPresent(before), `the cue was already on screen before its start (mean ${before.toFixed(1)})`)
      assert.ok(!labelPresent(after), `the cue was still on screen after its end (mean ${after.toFixed(1)})`)
      for (const at of [2.6, 5, 7.5, 10.4]) {
        const mean = await sampleRegion(file, at, region, dir)
        assert.ok(labelPresent(mean), `the cue dropped out at t=${at}s (mean ${mean.toFixed(1)})`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('four corners and a precise anchor coexist in one graph', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cue-all-'))
    try {
      // Every cue on screen at once, which is also the case that would catch a
      // filtergraph the real parser rejects.
      const cues: ContextualCue[] = [
        ...CONTEXTUAL_CUE_CORNERS.map((corner, index) => cue({ id: `cue-${corner}`, placement: corner as ContextualCueCorner, title: `C${index}` })),
        cue({ id: 'cue-centre', title: 'MID', position_x_pct: 50, position_y_pct: 50 }),
      ]
      const file = await renderWithCues(cues, 5, dir)
      for (const name of Object.keys(REGIONS) as RegionName[]) {
        const mean = await sampleRegion(file, 2.5, REGIONS[name], dir)
        assert.ok(labelPresent(mean), `nothing rendered in the ${name} region (mean ${mean.toFixed(1)})`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
