/**
 * A title image the Scene Plan did not reserve must not push every scene
 * behind its narration.
 *
 * Dreamlands E2E 2026-10-03 (EP0002): Video Assembly turned a 5 s title image
 * on by default, Scene Plan had reserved nothing, so the narration played
 * under the title image and every scene appeared 5 s after its words. Now the
 * narration (and captions) start after a silent opening the plan did not
 * reserve, so scenes and narration move together.
 */

import { before, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

let dir: string
let cleanup: () => Promise<void>
let video: typeof import('../generators/video.js')

before(async () => {
  const t = await useTempDataDir()
  dir = t.dir
  cleanup = t.cleanup
  video = await import('../generators/video.js')
})
after(async () => { await cleanup() })

describe('narration lead-in for an unreserved opening', () => {
  test('a 5 s title image the plan did not reserve delays the narration by 5 s', () => {
    assert.equal(video.narrationLeadInForOpening({ planStrict: true, sceneTimelineOffsetSec: 5, introVideoInOpening: false }), 5)
  })
  test('nothing moves when the plan reserved the opening, for an intro video, or for Image Pool', () => {
    assert.equal(video.narrationLeadInForOpening({ planStrict: true, sceneTimelineOffsetSec: 0, introVideoInOpening: false }), 0)
    assert.equal(video.narrationLeadInForOpening({ planStrict: true, sceneTimelineOffsetSec: 8, introVideoInOpening: true }), 0)
    assert.equal(video.narrationLeadInForOpening({ planStrict: false, sceneTimelineOffsetSec: 5, introVideoInOpening: false }), 0)
    assert.equal(video.narrationLeadInForOpening({ planStrict: true, sceneTimelineOffsetSec: -3, introVideoInOpening: false }), 0)
  })

  test('the premixed soundtrack is silent for the lead-in and the narration follows it', async () => {
    const tone = path.join(dir, 'tone.wav')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', tone])
    const out = await video.premixAudio({
      narrationPath: tone,
      narrationDuration: 2,
      narrationVolume: 1,
      narrationDelaySec: 1.5,
      targetDuration: 4,
      tempDir: dir,
      job: { output_lines: [] } as any,
    })
    const detect = (start: number, len: number): number => {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(start), '-t', String(len), '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
      const m = /max_volume: (-?inf|-?[\d.]+) dB/.exec(r.stderr)
      return m ? (m[1].includes('inf') ? -Infinity : Number(m[1])) : NaN
    }
    assert.ok(detect(0, 1.3) < -60, 'the lead-in must be silent')
    assert.ok(detect(1.7, 1.5) > -40, 'the narration must play after the lead-in')
    await fs.rm(out, { force: true })
  })
})
