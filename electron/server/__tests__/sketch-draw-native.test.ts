import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  NATIVE_SCENE_CLIP_VERSION, NATIVE_CLIP_QUALITY, SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS, SketchDrawError, sketchDefaultHoldFrames,
  renderSketchDraw, validateSketchDrawJob, type SketchDrawJob,
} from '../lib/native-scene-clip.js'

const base: SketchDrawJob = {
  kind: 'sketch', input: '/input/scene.png', output: '/output/scene.mp4',
  width: 1920, height: 1080, fps: 30, frames: 247, paper: '#ffffff', pen: { mode: 'none' },
}
const hasCode = (code: SketchDrawError['code']) => (error: unknown) => error instanceof SketchDrawError && error.code === code

async function scratch(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sketch-draw-wrapper-'))
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  return { ...base, output: path.join(dir, 'scene.mp4') }
}

test('Sketch Draw job has exact integer frames and accepts the four pen modes and supported frame rates', () => {
  assert.equal(NATIVE_SCENE_CLIP_VERSION, 3)
  for (const fps of [24, 25, 30, 60]) {
    for (const pen of [{ mode: 'none' }, { mode: 'plain' }, { mode: 'name', text: 'Channel Name' }, { mode: 'logo', logo: '/profile/logo.webp' }] as SketchDrawJob['pen'][]) {
      assert.doesNotThrow(() => validateSketchDrawJob({ ...base, fps, pen }))
    }
  }
  assert.doesNotThrow(() => validateSketchDrawJob({ ...base, frames: 1, width: 640, height: 480 }))
})

test('Sketch Draw rejects malformed JSON fields before invoking a helper', async () => {
  for (const patch of [
    { kind: 'camera' }, { width: 1919 }, { height: 0 }, { width: 4098 },
    { fps: 29.97 }, { fps: 0 }, { fps: 121 }, { frames: 0 }, { frames: 1.5 }, { frames: 1_000_001 },
    { paper: 'white' }, { paper: '#fff' }, { quality: NaN }, { quality: 1.01 },
    { input: 'relative.png' }, { output: base.input }, { output: '/input/../input/scene.png' },
    { hold_frames: 0 }, { hold_frames: 246 }, { hold_frames: 1.5 }, { frames: 2, hold_frames: 1 },
    { pen: null }, { pen: { mode: 'hand' } }, { pen: { mode: 'name', text: ' ' } },
    { pen: { mode: 'name', text: 'x'.repeat(257) } }, { pen: { mode: 'logo', logo: 'relative.png' } },
  ]) {
    let ran = false
    await assert.rejects(renderSketchDraw({ ...base, ...patch } as SketchDrawJob, { run: async () => { ran = true; return { code: 0, stderr: '' } } }), hasCode('bad_job'))
    assert.equal(ran, false)
  }
})

test('Sketch Draw writes contract JSON and returns only after a nonempty output; scratch job is removed', async t => {
  const job = await scratch(t)
  let jobPath = ''
  const result = await renderSketchDraw(job, { run: async (_helper, file) => {
    jobPath = file
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ...job, quality: NATIVE_CLIP_QUALITY })
    await fs.writeFile(job.output, 'fixture clip; integration owns decode verification')
    return { code: 0, stderr: '' }
  } })
  assert.deepEqual(result, { rendered: true, kind: 'sketch', frames: 247 })
  await assert.rejects(fs.stat(jobPath), { code: 'ENOENT' })
})

test('missing helper or version refusal is a typed loud error without fallback', async t => {
  const job = await scratch(t)
  for (const reason of ['helper binary not found', 'helper version 1 does not match app (2)']) {
    await assert.rejects(renderSketchDraw(job, { probe: async () => ({ available: false, path: null, reason }) }), error => hasCode('unsupported')(error) && String(error).includes(reason))
  }
})

test('native bad-job, unsupported, failure and timeout exits preserve typed failure and remove job files', async t => {
  const job = await scratch(t)
  for (const [code, expected] of [[2, 'bad_job'], [3, 'unsupported'], [4, 'failed'], [null, 'failed']] as const) {
    let file = ''
    await assert.rejects(renderSketchDraw(job, { run: async (_helper, jobPath) => { file = jobPath; return { code, stderr: 'specific helper failure' } } }), error => hasCode(expected)(error) && /specific helper failure/.test(String(error)))
    await assert.rejects(fs.stat(file), { code: 'ENOENT' })
  }
})

test('zero exit with missing or empty clip fails and a retry can repair it', async t => {
  const job = await scratch(t)
  await assert.rejects(renderSketchDraw(job, { run: async () => ({ code: 0, stderr: '' }) }), hasCode('failed'))
  const empty = { ...job, output: job.output + '.empty.mp4' }
  await assert.rejects(renderSketchDraw(empty, { run: async () => { await fs.writeFile(empty.output, ''); return { code: 0, stderr: '' } } }), hasCode('failed'))
  const result = await renderSketchDraw(job, { run: async () => { await fs.writeFile(job.output, 'repaired'); return { code: 0, stderr: '' } } })
  assert.equal(result.frames, 247)
})

test('Sketch Draw never replaces a prior accepted clip or overwrites an existing job file', async t => {
  const job = await scratch(t)
  await fs.writeFile(job.output, 'accepted bytes')
  let ran = false
  await assert.rejects(renderSketchDraw(job, { run: async () => { ran = true; return { code: 0, stderr: '' } } }), hasCode('bad_job'))
  assert.equal(ran, false)
  assert.equal(await fs.readFile(job.output, 'utf8'), 'accepted bytes')
  const jobPath = job.output + '.existing.json'
  await fs.writeFile(jobPath, 'prior job')
  await assert.rejects(renderSketchDraw({ ...job, output: job.output + '.new' }, { jobPath, run: async () => ({ code: 0, stderr: '' }) }), hasCode('failed'))
  assert.equal(await fs.readFile(jobPath, 'utf8'), 'prior job')
})

test('Sketch Draw rejects cancellation before starting and after an in-flight render settles', async t => {
  const job = await scratch(t)
  const before = new AbortController(); before.abort()
  let ran = false
  await assert.rejects(renderSketchDraw(job, { signal: before.signal, run: async () => { ran = true; return { code: 0, stderr: '' } } }), hasCode('cancelled'))
  assert.equal(ran, false)
  const during = new AbortController()
  let jobPath = ''
  await assert.rejects(renderSketchDraw(job, { signal: during.signal, run: async (_helper, file) => {
    jobPath = file; during.abort(); await fs.writeFile(job.output, 'unaccepted temporary clip'); return { code: 0, stderr: '' }
  } }), hasCode('cancelled'))
  await assert.rejects(fs.stat(jobPath), { code: 'ENOENT' })
})

// These tests pin process/job boundaries, not visual quality or encoded media validity.

test('closing hold is min(2.5 s, half the clip) with the documented tiny-clip degradation', () => {
  assert.equal(sketchDefaultHoldFrames(240, 30), 75, '8 s at 30 fps holds 2.5 s')
  assert.equal(sketchDefaultHoldFrames(90, 30), 45, '3 s holds half the clip')
  assert.equal(sketchDefaultHoldFrames(12, 24), 6, '0.5 s holds half the clip')
  assert.equal(sketchDefaultHoldFrames(3, 24), 1)
  assert.equal(sketchDefaultHoldFrames(2, 24), 2, 'fewer than 3 frames: finished image only')
  assert.equal(sketchDefaultHoldFrames(1, 24), 1)
  for (const [frames, fps] of [[247, 30], [100, 25], [120, 60], [5, 24], [4, 60]] as const) {
    const hold = sketchDefaultHoldFrames(frames, fps)
    assert.ok(hold >= 1 && hold <= frames - 2, `${frames}f@${fps}: hold ${hold} leaves ink and colour a frame each`)
    assert.doesNotThrow(() => validateSketchDrawJob({ ...base, frames, fps, hold_frames: hold }))
  }
  assert.doesNotThrow(() => validateSketchDrawJob({ ...base, frames: 2, hold_frames: 2 }))
})

test('version-2 Sketch Draw clips stay valid renders for freshness', () => {
  assert.deepEqual([...SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS], [2, 3])
  assert.ok(SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS.includes(NATIVE_SCENE_CLIP_VERSION))
  assert.ok(!SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS.includes(1))
})

test('hold_frames reaches the helper in the job JSON', async t => {
  const job = { ...(await scratch(t)), hold_frames: 75 }
  let seen: any
  await renderSketchDraw(job, { run: async (_helper, file) => {
    seen = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(job.output, 'clip')
    return { code: 0, stderr: '' }
  } })
  assert.equal(seen.hold_frames, 75)
})

test('a helper that stalls on the encoder fails with a clear message instead of hanging until the Node timeout', async t => {
  const job = await scratch(t)
  // Simulate what the fixed Swift helper now does: fail with exit 4 and a stall message
  // rather than spinning on isReadyForMoreMediaData forever.
  const result = await renderSketchDraw(job, {
    run: async () => ({ code: null, stderr: 'timed out after 600s' }),
  }).catch((e: unknown) => e)
  assert.ok(result instanceof SketchDrawError)
  assert.equal(result.code, 'failed')
  assert.match(result.message, /timed out/)
  // The fixed helper would instead produce: "sketch encoder stall: waited 10s for isReadyForMoreMediaData at frame N"
  const stallResult = await renderSketchDraw(job, {
    run: async () => ({ code: 4, stderr: 'scene-clip: sketch encoder stall: waited 10s for isReadyForMoreMediaData at frame 847' }),
  }).catch((e: unknown) => e)
  assert.ok(stallResult instanceof SketchDrawError)
  assert.equal(stallResult.code, 'failed')
  assert.match(stallResult.message, /encoder stall/)
  assert.match(stallResult.message, /frame 847/)
})
