/**
 * 1.4.265 — the final composition renders in checkpointed segments (lib/segmented-render.ts) so an
 * update, crash or Quit loses at most one segment. Covered here: the segment plan (and the still
 * tail loop), the resume graph, taking the one-shot argv apart, a lossless frame-for-frame proof
 * that an interrupted-then-resumed render equals the one-shot render, the checkpoint records, and
 * runFinalComposition itself resuming, re-validating and invalidating segments.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import {
  canResumeGraph, concatMuxArgs, frameSecFromFramemd5, planFinalSegments, resumeFilterGraph, segmentCount,
  segmentFileName, segmentRange, segmentRenderArgs, sha256File, splitOneShotArgv, STILL_TAIL_LOOP_SEC,
} from '../lib/segmented-render.js'
import {
  createVideoAssemblyCheckpoint, getValidVideoAssemblyCheckpoint, moveCheckpointFinalSegments, moveCheckpointFinalStage,
  type VideoAssemblyCheckpoint,
} from '../lib/video-assembly-checkpoint.js'
import { getWorkTempDir } from '../lib/work-tempdir.js'
import type { Job } from '../models/types.js'

const tmp = await useTempDataDir()
after(() => tmp.cleanup())

const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' })
const frameHashes = (file: string, map = '0:v') => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', map, '-f', 'framemd5', '-'])
  .toString().split('\n').filter(line => /^\d/.test(line)).map(line => line.split(',').at(-1)!.trim())

describe('segment plan', () => {
  test('3-minute segments on the output frame grid; the last one runs to the end', () => {
    const plan = planFinalSegments(6185.073333, 0.04)
    assert.equal(segmentCount(plan), 35)
    assert.deepEqual(plan.cut_frames.slice(0, 2), [4500, 9000])
    assert.deepEqual(segmentRange(plan, 0), { start_sec: 0, end_sec: 180 })
    assert.equal(segmentRange(plan, 34).end_sec, 6185.073333)
    for (let i = 1; i < segmentCount(plan); i++) assert.equal(segmentRange(plan, i).start_sec, segmentRange(plan, i - 1).end_sec)
    assert.deepEqual(plan.order, Array.from({ length: 35 }, (_, i) => i))
    assert.equal(segmentCount(planFinalSegments(180.3, 1 / 24)), 1, 'no sliver segment at the end')
    // 24 fps grid: a cut is a real frame's time.
    assert.equal(planFinalSegments(400, 1 / 24).cut_frames[0], 4320)
  })

  test('a still tail renders 30 s once and repeats it; the pieces add up to the whole video', () => {
    // TerraNash TN0183: the after-outro still starts at 2600.07 s of a 6185.07 s render.
    const plan = planFinalSegments(6185.073333, 0.04, { stillTailFromSec: 2600.07 })
    assert.equal(plan.tail_loop?.from_sec, 2603)
    assert.equal(plan.tail_loop?.repeats, 118)
    assert.ok(Math.abs(plan.render_end_sec - (6185.073333 - 118 * STILL_TAIL_LOOP_SEC)) < 1e-6)
    const unit = plan.tail_loop!.unit
    assert.deepEqual(segmentRange(plan, unit), { start_sec: 2603, end_sec: 2633 })
    const played = plan.order.reduce((sum, i) => sum + segmentRange(plan, i).end_sec - segmentRange(plan, i).start_sec, 0)
    assert.ok(Math.abs(played - 6185.073333) < 1e-6, `played ${played}`)
    assert.ok(segmentRange(plan, unit + 1).end_sec - segmentRange(plan, unit + 1).start_sec >= 1, 'the last piece keeps at least a second')
    assert.equal(plan.order.filter(i => i === unit).length, 119)
    // Too short to be worth a loop: plain segments.
    assert.equal(planFinalSegments(100, 0.04, { stillTailFromSec: 60 }).tail_loop, undefined)
  })

  test('the frame grid is read from a 2-frame framemd5 run', () => {
    assert.equal(frameSecFromFramemd5('#tb 0: 1/25\n#stream#, dts, pts, duration, size, hash\n0, 0, 0, 1, 1382400, ab\n'), 0.04)
    assert.equal(frameSecFromFramemd5('#tb 0: 1/12288\n0, 0, 0, 512, 10, ab\n'), 1 / 24)
    assert.equal(frameSecFromFramemd5('nothing'), null)
  })
})

describe('resume graph and argv', () => {
  const graph = "[0:v]setpts=PTS-STARTPTS[v0];\n[v0]eq=brightness='0.011*sin(2*PI*t*8)':eval=frame:enable='between(t,50,2600)'[v1];\n[v1]noise=alls=11:allf=t+u[v2];\n[v2]null[vout]"

  test('the main picture starts 2 s early with its own timestamps; the output starts exactly at the cut', () => {
    assert.ok(canResumeGraph(graph))
    assert.equal(resumeFilterGraph(graph, 0), graph)
    const resumed = resumeFilterGraph(graph, 360)
    assert.match(resumed, /^\[0:v\]setpts=PTS-STARTPTS,trim=start=358\.000000\[v0\];/)
    assert.match(resumed, /\[v2\]select='gte\(t,359\.999990\)',setpts=PTS-STARTPTS\[vout\]$/)
    assert.equal(resumed.split('eq=brightness').length, 2, 'every effect is left exactly as it was')
  })

  test('a graph that counts frames, or reads the main picture twice, renders in one piece', () => {
    assert.equal(canResumeGraph(graph.replace('noise=alls=11:allf=t+u', "zoompan=z='1+0.001*on'")), false)
    assert.equal(canResumeGraph(graph.replace('[v2]null[vout]', '[v2][0:v]overlay[vout]')), false)
    assert.equal(canResumeGraph('[0:v]scale=2:2[vout]'), false)
  })

  test('the one-shot argv is taken apart into the segment render and the final join', () => {
    const argv = ['-y', '-i', '/w/intermediate_video.mp4', '-i', '/w/premixed_audio.wav', '-i', '/logo.png',
      '-filter_complex', graph, '-map', '[vout]', '-map', '1:a',
      '-c:v', 'libx265', '-crf', '28', '-preset', 'medium', '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '192k',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', '6185.073333', '/w/EP_video_1.mp4']
    const split = splitOneShotArgv(argv)!
    assert.equal(split.audio_input, '/w/premixed_audio.wav')
    assert.deepEqual(split.audio_args, ['-c:a', 'aac', '-b:a', '192k'])
    assert.deepEqual(split.mux_args, ['-movflags', '+faststart'])
    assert.deepEqual(split.video_args, ['-c:v', 'libx265', '-crf', '28', '-preset', 'medium', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'])
    const plan = planFinalSegments(6185.073333, 0.04)
    const resumed = segmentRenderArgs(split, plan, 2, '/w/final_segments/final_seg_%04d.mp4', '/w/list.csv')
    assert.equal(resumed[resumed.indexOf('-filter_complex') + 1], resumeFilterGraph(graph, 360))
    assert.equal(resumed[resumed.indexOf('-t') + 1], '5825.073333')
    assert.equal(resumed[resumed.indexOf('-force_key_frames') + 1].split(',')[0], '179.999990')
    assert.equal(resumed[resumed.indexOf('-segment_start_number') + 1], '2')
    assert.ok(!resumed.includes('1:a'), 'segments are video only')
    const join = concatMuxArgs(split, '/w/final_concat.txt')
    assert.deepEqual(join.slice(join.indexOf('-c:v'), join.indexOf('-c:v') + 4), ['-c:v', 'copy', '-tag:v', 'hvc1'])
    assert.deepEqual(join.slice(-3), ['-t', '6185.073333', '/w/EP_video_1.mp4'])
    // The no-effects recovery tier has no graph: it renders in one piece.
    assert.equal(splitOneShotArgv(['-y', '-i', 'a', '-i', 'b', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'aac', '-t', '1', 'o.mp4']), null)
  })
})

describe('a resumed render skips what it does not draw', () => {
  test('a looped still is seeked with its own timestamps; a colour board is trimmed; anything that may end is left alone', () => {
    const graph = [
      '[0:v]setpts=PTS-STARTPTS[v0]',
      '[v0]scale=280:150[media]',
      'color=c=#101820:s=320x180:r=25[board]',
      "color=c=white:s=280x150:r=24,trim=end_frame=1,format=gray,geq=lum='255',loop=loop=-1:size=1[mask]",
      'color=c=black:s=320x180:d=5[short]',
      '[2:v]setpts=PTS-STARTPTS,scale=320:180[bg]',
      '[bg][media]overlay=20:15:shortest=1[v1]',
      '[v1]null[vout]',
    ].join(';\n')
    const argv = ['-y', '-i', '/w/intermediate_video.mp4', '-i', '/w/premixed_audio.wav', '-c:v', 'png', '-loop', '1', '-i', '/bg.png',
      '-loop', '1', '-t', '3', '-i', '/card.png', '-i', '/logo.png',
      '-filter_complex', graph, '-map', '[vout]', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '192k', '-t', '600', '/w/o.mp4']
    const split = splitOneShotArgv(argv)!
    const plan = planFinalSegments(600, 0.04)
    const fresh = segmentRenderArgs(split, plan, 0, '/w/s_%04d.mp4', '/w/l.csv')
    assert.ok(!fresh.includes('-itsoffset'), 'a render from the start is the one-shot command')
    const resumed = segmentRenderArgs(split, plan, 2, '/w/s_%04d.mp4', '/w/l.csv')
    assert.deepEqual(resumed.slice(resumed.indexOf('/w/premixed_audio.wav') + 1, resumed.indexOf('/bg.png') + 1),
      ['-c:v', 'png', '-loop', '1', '-ss', '358.000000', '-itsoffset', '358.000000', '-i', '/bg.png'])
    assert.equal(resumed[resumed.indexOf('/card.png') - 3], '-t', 'a still limited by -t is not seeked')
    const g = resumed[resumed.indexOf('-filter_complex') + 1]!
    assert.match(g, /\[2:v\]setpts=PTS,scale/)
    assert.match(g, /color=c=#101820:s=320x180:r=25,trim=start=358\.000000\[board\]/)
    assert.match(g, /loop=loop=-1:size=1\[mask\]/, 'the one-frame mask is untouched')
    assert.match(g, /color=c=black:s=320x180:d=5\[short\]/, 'a source that ends is untouched')
  })
})

describe('lossless proof with FFmpeg', () => {
  test('one-shot, and interrupted then resumed, give the same frames and the same audio; a still tail loop too', async () => {
    const dir = path.join(tmp.dir, 'proof')
    await fs.mkdir(path.join(dir, 'final_segments'), { recursive: true })
    const p = (name: string) => path.join(dir, name)
    // 10 s moving picture, then a 7 s still (as TerraNash's after-outro image), a frame board at 25 fps.
    // Like TerraNash (6200 s intermediate, 6185 s render), the picture runs past the end, so `-t` ends both renders.
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=10', '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('a.mp4')])
    ffmpeg(['-i', p('a.mp4'), '-vf', 'select=eq(n\\,0)', '-frames:v', '1', p('still.png')])
    ffmpeg(['-loop', '1', '-framerate', '24', '-i', p('still.png'), '-t', '7', '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('b.mp4')])
    await fs.writeFile(p('list.txt'), `file '${p('a.mp4')}'\nfile '${p('b.mp4')}'\n`)
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', p('list.txt'), '-c', 'copy', p('intermediate_video.mp4')])
    ffmpeg(['-f', 'lavfi', '-i', 'sine=f=330:d=16', '-ar', '48000', p('premixed_audio.wav')])
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x203040:s=400x240', '-frames:v', '1', p('bg.png')])
    const graph = [
      '[0:v]setpts=PTS-STARTPTS[v0]',
      "[v0]eq=brightness='0.08*sin(2*PI*t)':eval=frame:enable='lt(t,10)'[v1]",
      '[v1]scale=280:150,format=rgba[media]',
      '[3:v]setpts=PTS-STARTPTS,scale=320:180[bg]',
      '[bg][media]overlay=20:15:shortest=1,format=yuv420p[v2]',
      '[v2]null[vout]',
    ].join(';\n')
    const oneShot = (out: string) => ['-y', '-i', p('intermediate_video.mp4'), '-i', p('premixed_audio.wav'), '-i', p('still.png'),
      '-c:v', 'png', '-loop', '1', '-i', p('bg.png'), '-filter_complex', graph, '-map', '[vout]', '-map', '1:a',
      '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-t', '16', out]
    ffmpeg(oneShot(p('oneshot.mp4')).slice(1))

    const split = splitOneShotArgv(oneShot(p('segmented.mp4')))!
    ffmpeg([...split.pre.slice(1, split.graph_index), '-filter_complex', graph, ...split.pre.slice(split.graph_index),
      '-map', '[vout]', '-frames:v', '2', '-f', 'framemd5', p('probe.framemd5')])
    const frameSec = frameSecFromFramemd5(await fs.readFile(p('probe.framemd5'), 'utf8'))!
    assert.equal(frameSec, 0.04, 'the frame board drives the output at 25 fps')
    const render = async (plan: ReturnType<typeof planFinalSegments>, out: string) => {
      // The "interrupted" run: every segment, then all but the first are lost; the resume renders from segment 1.
      ffmpeg(segmentRenderArgs(split, plan, 0, p('final_segments/final_seg_%04d.mp4'), p('l0.csv')).slice(1))
      assert.equal((await fs.readFile(p('l0.csv'), 'utf8')).trim().split('\n').length, segmentCount(plan), 'every finished segment is listed')
      for (let i = 1; i < segmentCount(plan); i++) await fs.rm(p(`final_segments/${segmentFileName(i)}`))
      ffmpeg(segmentRenderArgs(split, plan, 1, p('final_segments/final_seg_%04d.mp4'), p('l1.csv')).slice(1))
      await fs.writeFile(p('concat.txt'), plan.order.map(i => `file '${p(`final_segments/${segmentFileName(i)}`)}'`).join('\n') + '\n')
      ffmpeg(concatMuxArgs({ ...split, output: out }, p('concat.txt')).slice(1))
    }
    const reference = frameHashes(p('oneshot.mp4'))
    await render(planFinalSegments(16, frameSec, { segmentSec: 4 }), p('segmented.mp4'))
    assert.deepEqual(frameHashes(p('segmented.mp4')), reference, 'every frame identical (lossless)')
    assert.deepEqual(frameHashes(p('segmented.mp4'), '0:a'), frameHashes(p('oneshot.mp4'), '0:a'), 'the audio identical')

    const looped = planFinalSegments(16, frameSec, { segmentSec: 4, stillTailFromSec: 10, loopSec: 1 })
    assert.equal(looped.tail_loop?.repeats, 2)
    await render(looped, p('looped.mp4'))
    assert.deepEqual(frameHashes(p('looped.mp4')), reference, 'the looped still tail is the same frames too')
  })
})

describe('checkpoint records', () => {
  test('finished segments are validated, and move with the scene clips into a fresh work folder', async () => {
    const job = { job_id: 'seg-ck', project_slug: 'seg-slug', episode_id: 'EP1', type: 'video_assembly', status: 'running' } as Job
    const oldDir = await getWorkTempDir('seg-slug', 'EP1')
    await fs.mkdir(path.join(oldDir, 'final_segments'))
    const seg = { index: 0, start_sec: 0, end_sec: 180, path: path.join(oldDir, 'final_segments', segmentFileName(0)), bytes: 3, sha256: 'b'.repeat(64) }
    await fs.writeFile(seg.path, 'abc')
    const checkpoint = createVideoAssemblyCheckpoint(job, oldDir, 'a'.repeat(64), [], { fingerprint: 'c'.repeat(64), segments: [seg] })
    job.result = { video_assembly_checkpoint: checkpoint }
    assert.ok(await getValidVideoAssemblyCheckpoint(job))
    job.result = { video_assembly_checkpoint: { ...checkpoint, final_segments: { fingerprint: 'c'.repeat(64), segments: [{ ...seg, path: '/elsewhere/final_seg_0000.mp4' }] } } }
    assert.equal(await getValidVideoAssemblyCheckpoint(job), null, 'a segment outside the job\'s own folder is refused')

    const newDir = await getWorkTempDir('seg-slug', 'EP1')
    const moved = await moveCheckpointFinalSegments(checkpoint, newDir)
    assert.equal(moved?.segments[0]?.path, path.join(newDir, 'final_segments', segmentFileName(0)))
    assert.equal(await fs.readFile(moved!.segments[0]!.path, 'utf8'), 'abc')
  })
})

describe('runFinalComposition resumes from its segments', () => {
  test('a restart keeps finished segments; a damaged one and every later one are rendered again; changed settings re-render all', async () => {
    const { _runFinalCompositionForTesting: runFinalComposition } = await import('../generators/video.js')
    const dir = await getWorkTempDir('seg-run', 'EP2')
    const p = (name: string) => path.join(dir, name)
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('intermediate_video.mp4')])
    ffmpeg(['-f', 'lavfi', '-i', 'sine=f=440:d=12', '-ar', '48000', p('premixed_audio.wav')])
    const job = { job_id: 'seg-run', project_slug: 'seg-run', episode_id: 'EP2', type: 'video_assembly', status: 'running',
      title: 'segments', created_at: '', started_at: '', finished_at: null, error: null, output_lines: [], params: {} } as unknown as Job
    const checkpoint: VideoAssemblyCheckpoint = createVideoAssemblyCheckpoint(job, dir, 'd'.repeat(64))
    let persisted = 0
    const run = async (strength: number) => {
      job.output_lines = []
      const outputFile = p(`EP2_video_${Date.now()}.mp4`)
      await runFinalComposition({
        videoInputPath: p('intermediate_video.mp4'), premixedAudioPath: p('premixed_audio.wav'),
        targetDuration: 12, w: 320, h: 180, quality: { crf: 23, preset: 'ultrafast', fps: 24 }, format: 'mp4', outputFile,
        vignette: { enabled: true, strength }, job,
        segmentation: { checkpoint, inputsFingerprint: 'e'.repeat(64), persist: async () => { persisted++ }, segmentSec: 4 },
      } as any)
      const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outputFile]).toString())
      assert.ok(Math.abs(seconds - 12) < 0.1, `the joined video is 12 s (${seconds})`)
      await fs.rename(outputFile, p(`kept-${Date.now()}.mp4`))
      return job.output_lines.join('\n')
    }
    const stat = (i: number) => fs.stat(checkpoint.final_segments!.segments[i]!.path)

    const first = await run(0.5)
    assert.match(first, /Final render: 3 segment\(s\)/)
    assert.match(first, /joining 3 segment\(s\) without re-encoding/)
    assert.equal(checkpoint.final_segments?.segments.length, 3)
    assert.ok(persisted >= 3, 'each finished segment is saved to the job as it lands')

    // A restart: the last segment was never finished.
    const kept = [(await stat(0)).mtimeMs, (await stat(1)).mtimeMs]
    const lost = checkpoint.final_segments!.segments.pop()!
    await fs.rm(lost.path)
    assert.match(await run(0.5), /resuming at segment 3 of 3; 2 finished segment\(s\)/)
    assert.deepEqual([(await stat(0)).mtimeMs, (await stat(1)).mtimeMs], kept, 'finished segments are not rendered again')

    // A segment whose bytes changed fails its sha256: it and everything after it are rendered again.
    const second = checkpoint.final_segments!.segments[1]!
    const bytes = await fs.readFile(second.path)
    bytes[bytes.length - 10] ^= 0xff
    await fs.writeFile(second.path, bytes)
    assert.match(await run(0.5), /resuming at segment 2 of 3; 1 finished segment\(s\)/)

    // Any change to what is rendered invalidates every segment.
    const before = (await stat(0)).mtimeMs
    const changed = await run(0.9)
    assert.match(changed, /were made with different inputs or settings, so every segment is rendered again/)
    assert.doesNotMatch(changed, /resuming at segment/)
    assert.notEqual((await stat(0)).mtimeMs, before)
  })
})

describe('a final render interrupted by an update', () => {
  test('finishes in a fresh work folder with its own saved command: kept segments untouched, the same length', async () => {
    const { _runFinalCompositionForTesting: runFinalComposition, resumeSavedFinalRender } = await import('../generators/video.js')
    const oldDir = await getWorkTempDir('seg-upd', 'EP3')
    const p = (name: string) => path.join(oldDir, name)
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('intermediate_video.mp4')])
    ffmpeg(['-f', 'lavfi', '-i', 'sine=f=440:d=12', '-ar', '48000', p('premixed_audio.wav')])
    const job = { job_id: 'seg-upd', project_slug: 'seg-upd', episode_id: 'EP3', type: 'video_assembly', status: 'running',
      title: 'segments', created_at: '', started_at: '', finished_at: null, error: null, output_lines: [], params: {} } as unknown as Job
    const inputsFingerprint = 'f'.repeat(64)
    const checkpoint = createVideoAssemblyCheckpoint(job, oldDir, 'd'.repeat(64))
    const segmentation = (cp: VideoAssemblyCheckpoint) => ({ checkpoint: cp, inputsFingerprint, persist: async () => {}, segmentSec: 4 })
    const firstOutput = p('EP3_video_1.mp4')
    await runFinalComposition({
      videoInputPath: p('intermediate_video.mp4'), premixedAudioPath: p('premixed_audio.wav'),
      targetDuration: 12, w: 320, h: 180, quality: { crf: 23, preset: 'ultrafast', fps: 24 }, format: 'mp4', outputFile: firstOutput,
      colorGrading: { enabled: true, preset: 'custom', brightness: 0.05, contrast: 1.1, saturation: 1.2, warmth: 0, tint: 0 }, job,
      segmentation: segmentation(checkpoint),
    } as any)
    assert.equal(checkpoint.final_stage?.argv.at(-1), firstOutput)
    assert.equal(checkpoint.final_stage?.inputs, inputsFingerprint)
    // The update quit the app during the last segment.
    await fs.rm(checkpoint.final_segments!.segments.pop()!.path)
    const keptBytes = await fs.readFile(checkpoint.final_segments!.segments[1]!.path)

    // The new version starts: a fresh work folder, the saved files and segments moved into it.
    const newDir = await getWorkTempDir('seg-upd', 'EP3')
    const stage = await moveCheckpointFinalStage(checkpoint, newDir)
    assert.ok(stage, 'every saved file is there and unchanged')
    assert.ok(stage!.argv.every(arg => !arg.includes(oldDir)), 'the command now points at the fresh folder')
    const resumed = createVideoAssemblyCheckpoint(job, newDir, 'd'.repeat(64), [], await moveCheckpointFinalSegments(checkpoint, newDir))
    resumed.final_stage = stage!
    job.output_lines = []
    const output = await resumeSavedFinalRender(job, stage!, segmentation(resumed), 'mp4')
    const lines = job.output_lines.join('\n')
    assert.match(lines, /resuming at segment 3 of 3; 2 finished segment\(s\)/)
    assert.match(lines, /^Encoder: software \(libx264\)$/m)
    assert.deepEqual(await fs.readFile(resumed.final_segments!.segments[1]!.path), keptBytes, 'a kept segment is not rendered again')
    // The kept segments are the uninterrupted render's own frames; the last one is a fresh (lossy)
    // encode of the same picture, which the lossless proof above shows is pixel-identical before encoding.
    const before = frameHashes(firstOutput)
    const after = frameHashes(output)
    assert.equal(after.length, before.length)
    assert.deepEqual(after.slice(0, 8 * 24), before.slice(0, 8 * 24), 'the kept segments play exactly as before')
  })

  test('a saved file that changed means the episode starts over, as before', async () => {
    const job = { job_id: 'seg-chg', project_slug: 'seg-chg', episode_id: 'EP4', type: 'video_assembly', status: 'running' } as Job
    const oldDir = await getWorkTempDir('seg-chg', 'EP4')
    await fs.writeFile(path.join(oldDir, 'intermediate_video.mp4'), 'changed')
    const checkpoint = createVideoAssemblyCheckpoint(job, oldDir, 'd'.repeat(64))
    checkpoint.final_stage = { inputs: 'f'.repeat(64), argv: ['-y', '-i', path.join(oldDir, 'intermediate_video.mp4')],
      files: { 'intermediate_video.mp4': 'a'.repeat(64) }, total_render_sec: 12, still_tail_from: null }
    assert.equal(await moveCheckpointFinalStage(checkpoint, await getWorkTempDir('seg-chg', 'EP4')), null)
  })
})

describe('a final-stage input nested in a subfolder (Myth EP0012, 2026-10-20)', () => {
  // The saved command read its premixed audio from `loudness_first/`, the checkpoint recorded only
  // the work folder's top level, and the resumed FFmpeg (254) was then handed a command whose audio
  // the scene-clip migration had just deleted along with the old folder.
  const nestedPremix = (dir: string) => path.join(dir, 'loudness_first', 'premixed_audio.wav')

  test('the nested premix moves with the render, and the resumed command finds it', async () => {
    const { _runFinalCompositionForTesting: runFinalComposition, resumeSavedFinalRender } = await import('../generators/video.js')
    const oldDir = await getWorkTempDir('seg-nest', 'EP6')
    const p = (name: string) => path.join(oldDir, name)
    await fs.mkdir(path.dirname(nestedPremix(oldDir)), { recursive: true })
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('intermediate_video.mp4')])
    ffmpeg(['-f', 'lavfi', '-i', 'sine=f=440:d=12', '-ar', '48000', nestedPremix(oldDir)])
    const job = { job_id: 'seg-nest', project_slug: 'seg-nest', episode_id: 'EP6', type: 'video_assembly', status: 'running',
      title: 'segments', created_at: '', started_at: '', finished_at: null, error: null, output_lines: [], params: {} } as unknown as Job
    const inputsFingerprint = 'f'.repeat(64)
    const checkpoint = createVideoAssemblyCheckpoint(job, oldDir, 'd'.repeat(64))
    const segmentation = (cp: VideoAssemblyCheckpoint) => ({ checkpoint: cp, inputsFingerprint, persist: async () => {}, segmentSec: 4 })
    const firstOutput = p('EP6_video_1.mp4')
    await runFinalComposition({
      videoInputPath: p('intermediate_video.mp4'), premixedAudioPath: nestedPremix(oldDir),
      targetDuration: 12, w: 320, h: 180, quality: { crf: 23, preset: 'ultrafast', fps: 24 }, format: 'mp4', outputFile: firstOutput,
      vignette: { enabled: true, strength: 0.5 }, job,
      segmentation: segmentation(checkpoint),
    } as any)
    assert.ok(checkpoint.final_stage?.files['loudness_first/premixed_audio.wav'],
      'the nested premixed audio is recorded as a dependency of the saved command')
    const premixBytes = await fs.readFile(nestedPremix(oldDir))
    // The update quit the app during the last segment.
    await fs.rm(checkpoint.final_segments!.segments.pop()!.path)
    const keptBytes = await fs.readFile(checkpoint.final_segments!.segments[1]!.path)

    // The new version starts: a fresh work folder. The whole dependency set moves, the nested one too.
    const newDir = await getWorkTempDir('seg-nest', 'EP6')
    assert.notEqual(newDir, oldDir)
    const stage = await moveCheckpointFinalStage(checkpoint, newDir)
    assert.ok(stage, 'every saved file is there and unchanged')
    assert.deepEqual(await fs.readFile(path.join(newDir, 'loudness_first', 'premixed_audio.wav')), premixBytes,
      'the nested premix is in the fresh folder, where the resumed command reads it')
    assert.ok(stage!.argv.every(arg => !arg.includes(oldDir)), 'the command now points at the fresh folder')

    const resumed = createVideoAssemblyCheckpoint(job, newDir, 'd'.repeat(64), [], await moveCheckpointFinalSegments(checkpoint, newDir))
    resumed.final_stage = stage!
    job.output_lines = []
    const output = await resumeSavedFinalRender(job, stage!, segmentation(resumed), 'mp4')
    const lines = job.output_lines.join('\n')
    assert.match(lines, /resuming at segment 3 of 3; 2 finished segment\(s\)/, 'the finished segments are kept, not rebuilt')
    assert.deepEqual(await fs.readFile(resumed.final_segments!.segments[1]!.path), keptBytes, 'a kept segment is not rendered again')
    const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output]).toString())
    assert.ok(Math.abs(seconds - 12) < 0.1, `the resumed render finishes the 12 s video (${seconds})`)
    // The audio that came across is the one the finished video carries.
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', output]).toString()
    assert.match(streams, /audio/, 'the resumed render carries the audio it was missing before')
  })

  test('a nested input that did not survive starts the episode over instead of resuming without it', async () => {
    const job = { job_id: 'seg-nest-lost', project_slug: 'seg-nest-lost', episode_id: 'EP7', type: 'video_assembly', status: 'running' } as Job
    const oldDir = await getWorkTempDir('seg-nest-lost', 'EP7')
    const video = path.join(oldDir, 'intermediate_video.mp4')
    await fs.writeFile(video, 'video')
    const checkpoint = createVideoAssemblyCheckpoint(job, oldDir, 'd'.repeat(64))
    checkpoint.final_stage = {
      inputs: 'f'.repeat(64),
      argv: ['-y', '-i', video, '-i', nestedPremix(oldDir), '-t', '12', path.join(oldDir, 'EP7_video_1.mp4')],
      // As an older checkpoint recorded it: the folder's top level only, so the nested premix is not here.
      files: { 'intermediate_video.mp4': await sha256File(video) },
      total_render_sec: 12, still_tail_from: null,
    }
    const newDir = await getWorkTempDir('seg-nest-lost', 'EP7-new')
    assert.equal(await moveCheckpointFinalStage(checkpoint, newDir), null,
      'a command whose nested input is gone is never resumed against the missing file')
    assert.equal(await fs.readFile(video, 'utf8'), 'video', 'and the old folder is left whole, not emptied of what it still holds')
  })
})


describe('segments after a verified final (owner decision 2026-10-09)', () => {
  test('deleted right away with one size line, and only after verifyFinalVideo', async () => {
    const { deleteFinalSegments } = await import('../generators/video.js')
    const dir = await getWorkTempDir('seg-del', 'EP5')
    await fs.mkdir(path.join(dir, 'final_segments'))
    await fs.writeFile(path.join(dir, 'final_segments', segmentFileName(0)), Buffer.alloc(2048))
    await fs.writeFile(path.join(dir, 'final_segments', segmentFileName(1)), Buffer.alloc(2048))
    const job = { output_lines: [] as string[] } as unknown as Job
    await deleteFinalSegments(dir, job)
    await assert.rejects(fs.stat(path.join(dir, 'final_segments')), 'gone, not moved to the Trash Folder')
    assert.deepEqual(job.output_lines, ['Final render: deleted 2 segment file(s), 4 KB freed.'])
    const src = await fs.readFile(new URL('../generators/video.ts', import.meta.url), 'utf8')
    const finish = src.slice(src.indexOf('async function finishFinalVideo('), src.indexOf('async function verifyFinalVideo('))
    assert.ok(finish.indexOf('await verifyFinalVideo(') < finish.indexOf('await deleteFinalSegments('), 'a failed check keeps the segments')
  })
})
