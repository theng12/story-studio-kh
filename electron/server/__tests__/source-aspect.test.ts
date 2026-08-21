/**
 * "Your pictures are not the shape of this render" (v1.4.15).
 *
 * These run real ffprobe over real generated images, because the whole value of
 * the check is that it reads what is actually on disk rather than what a scene
 * plan claims. A mocked prober would pass while the feature was blind.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { inspectSourceAspect } from '../lib/source-aspect.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'

let dir = ''

async function makeImage(name: string, w: number, h: number): Promise<string> {
  const out = path.join(dir, name)
  const bin = await getFFmpegPath()
  await new Promise<void>((resolve, reject) => {
    const p = spawn(bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=gray:s=${w}x${h}`, '-frames:v', '1', out,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d.toString() })
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err))))
  })
  return out
}

describe('source aspect check', () => {
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssk-source-aspect-'))
  })
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('says nothing when the pictures fit the frame', async () => {
    const images = [await makeImage('a.png', 1920, 1080), await makeImage('b.png', 1280, 720)]
    const report = await inspectSourceAspect(images, 1920, 1080)
    assert.equal(report.checked, 2)
    assert.equal(report.mismatched, 0)
    assert.equal(report.message, '')
  })

  test('names the shapes when a landscape set is rendered portrait', async () => {
    const images = [await makeImage('c.png', 1920, 1080), await makeImage('d.png', 1920, 1080)]
    const report = await inspectSourceAspect(images, 1080, 1920)
    assert.equal(report.mismatched, 2)
    assert.equal(report.source_aspect, '16:9')
    assert.equal(report.canvas_aspect, '9:16')
    assert.match(report.message, /Every scene image sampled is 16:9 \(1920×1080\)/)
    assert.match(report.message, /this render is 9:16 \(1080×1920\)/)
    // The orientation flip earns the stronger wording — this is the case where
    // most of the finished video would be black bar.
    assert.match(report.message, /large black bars/)
  })

  test('counts the mismatch rather than claiming all of them', async () => {
    const images = [
      await makeImage('e.png', 1080, 1920),
      await makeImage('f.png', 1080, 1920),
      await makeImage('g.png', 1920, 1080),
    ]
    const report = await inspectSourceAspect(images, 1080, 1920)
    assert.equal(report.checked, 3)
    assert.equal(report.mismatched, 1)
    assert.match(report.message, /^1 of 3 scene image/)
  })

  test('a near-miss is a crop, not an alarm', async () => {
    // 1344×768 is what the image presets actually emit for "16:9".
    const images = [await makeImage('h.png', 1344, 768)]
    const report = await inspectSourceAspect(images, 1920, 1080)
    assert.equal(report.mismatched, 0)
    assert.equal(report.message, '')
  })

  test('an unreadable source is skipped, never fatal', async () => {
    const broken = path.join(dir, 'not-an-image.png')
    await fs.writeFile(broken, 'this is not a picture')
    const report = await inspectSourceAspect(
      [broken, await makeImage('i.png', 1920, 1080)], 1080, 1920,
    )
    assert.equal(report.checked, 1, 'the unreadable file is not counted')
    assert.equal(report.mismatched, 1)
  })

  test('no sources at all is silence, not a warning', async () => {
    const report = await inspectSourceAspect([], 1080, 1920)
    assert.equal(report.checked, 0)
    assert.equal(report.message, '')
  })
})
