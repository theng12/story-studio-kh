import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { tinyVideoBytes } from './fixtures/tiny-video.js'
import { assertPlayableSceneClip } from '../lib/scene-clip-media.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { prepareSceneClips } from '../generators/video.js'
import { buildVideoAssemblyRenderFingerprint } from '../lib/video-assembly-checkpoint.js'
import { videoStreamDuration } from '../lib/ffmpeg-validation.js'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-clip-media-'))
after(() => fs.rm(dir, { recursive: true, force: true }))

test('video stream timing falls back to ticks and average frame rate without container timing', () => {
  assert.equal(videoStreamDuration({ duration: 'N/A', duration_ts: 15360, time_base: '1/15360' }), 1)
  assert.equal(videoStreamDuration({ duration: '2', duration_ts: 15360, time_base: '1/15360' }), 2)
  assert.equal(videoStreamDuration({ nb_frames: '30', avg_frame_rate: '30/1', r_frame_rate: '60/1' }), 1)
  assert.equal(videoStreamDuration({ duration: 'N/A', time_base: '1/0', nb_frames: 0 }), undefined)
  assert.equal(videoStreamDuration(undefined), undefined)
})

test('validates real media and frame rounding without changing the file', async () => {
  const file = path.join(dir, 'valid.mp4')
  await fs.writeFile(file, tinyVideoBytes())
  assert.equal(await assertPlayableSceneClip(file, 1), 1)
  assert.equal(await assertPlayableSceneClip(file, 1.1), 1)
  for (const expected of [0.5, 2, NaN, 0]) await assert.rejects(assertPlayableSceneClip(file, expected), /needs review/)
  assert.deepEqual(await fs.readFile(file), tinyVideoBytes())
})

test('rejects empty, malformed and truncated files, retaining evidence', async () => {
  for (const [name, bytes] of [
    ['empty', Buffer.alloc(0)], ['garbage', Buffer.from('not video')],
    ['truncated', tinyVideoBytes().subarray(0, 1200)],
  ] as const) {
    const file = path.join(dir, `${name}.mp4`)
    await fs.writeFile(file, bytes)
    await assert.rejects(assertPlayableSceneClip(file), /File preserved:.*No replacement was submitted/)
    assert.deepEqual(await fs.readFile(file), bytes)
  }
})

test('a longer audio track cannot conceal short video; audio alone is rejected', async () => {
  const file = path.join(dir, 'long-audio.mp4')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=red:s=32x32:r=10:d=1', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-c:a', 'aac', file])
  assert.equal(await assertPlayableSceneClip(file, 1), 1)
  await assert.rejects(assertPlayableSceneClip(file, 2), /video contains 1.000s/)
  const audio = path.join(dir, 'audio.m4a')
  await runFfmpeg(['-y', '-i', file, '-vn', '-c:a', 'copy', audio])
  await assert.rejects(assertPlayableSceneClip(audio), /missing video stream/)
})

test('Follow narration holds the final frame including the transition tail; legacy clips loop', async () => {
  const source = path.join(dir, 'red-then-blue.mp4')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=red:s=32x32:r=10:d=0.5', '-f', 'lavfi', '-i', 'color=blue:s=32x32:r=10:d=0.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', source])
  const ffmpeg = await getFFmpegPath()
  for (const hold of [false, true]) {
    const outDir = path.join(dir, hold ? 'hold' : 'loop')
    await fs.mkdir(outDir)
    const scenes = [{ image_path: source, duration: 1.2, show_title: false, __scene_plan_duration: true, ...(hold ? { clip_shortfall_mode: 'hold' as const } : {}) }]
    const outputs = await prepareSceneClips(scenes, { type: 'none' } as any, { enabled: false } as any,
      32, 32, { crf: 18, preset: 'ultrafast', fps: 10 }, outDir, false,
      { seconds_per_scene: 1.2, shuffle: false, excluded_scenes: [] },
      { job_id: `clip-hold-${hold}`, output_lines: [], result: {}, params: {} } as any,
      { pool: [], randomizeMode: 'off', seed: 7 }, [1.2], 0.2)
    assert.equal(await assertPlayableSceneClip(outputs[0]!, 1.4), 1.4)
    const { stdout } = await promisify(execFile)(ffmpeg, ['-v', 'error', '-ss', '1.3', '-i', outputs[0]!, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' })
    assert.equal(stdout.length, 3)
    assert.ok(hold ? stdout[2]! > stdout[0]! + 100 : stdout[0]! > stdout[2]! + 100, `expected ${hold ? 'blue held frame' : 'red loop restart'}, got ${[...stdout]}`)
  }
  const request = { scenes: [{ image_path: source, duration: 1.2 }] }
  const legacy = await buildVideoAssemblyRenderFingerprint({ request: request as any })
  const held = await buildVideoAssemblyRenderFingerprint({ request: { scenes: [{ ...request.scenes[0], clip_shortfall_mode: 'hold' }] } as any })
  assert.notEqual(held, legacy, 'a loop checkpoint cannot be reused as a held clip')
})
