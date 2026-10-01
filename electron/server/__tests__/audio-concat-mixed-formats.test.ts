/**
 * A music list that mixes MP3 and M4A, or sample rates, must stitch to the sum of its tracks.
 *
 * FFmpeg's concat demuxer reads every file with the first file's codec and sample rate. Handed a
 * mixed list it logs decoder errors, drops the files it cannot read and still exits 0 — measured:
 * MP3 + M4A(32 kHz) + M4A(44.1 kHz), 3 s each, came out 3.0 s. A mix built from a library holding old
 * MP3 takes beside the AAC takes saved since 1.4.244 therefore lost tracks with no error.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { homogenizeForConcat, probeAudioSignature } from '../lib/audio-concat.js'
import { buildConcatList, buildStitchArgs } from '../services/music-render.js'

const ffmpeg = (...args: string[]) => assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]).status, 0)
const seconds = (f: string) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString())
const tone = (out: string, hz: number, rate: number, codec: string, fmt: string[] = []) =>
  ffmpeg('-f', 'lavfi', '-i', `sine=f=${hz}:d=3:r=${rate}`, '-c:a', codec, ...fmt, out)

async function stitch(dir: string, files: string[]): Promise<number> {
  const work = path.join(dir, 'norm')
  const { files: inputs } = await homogenizeForConcat(files, work)
  const list = path.join(dir, 'list.txt')
  await writeFile(list, buildConcatList(inputs))
  const out = path.join(dir, 'mix.mp3')
  assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', ...buildStitchArgs(list, out, 0)]).status, 0)
  return seconds(out)
}

describe('homogenizeForConcat', () => {
  test('MP3 + M4A at two sample rates stitch to the sum of all three tracks', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'concat-mixed-'))
    const a = path.join(dir, 'a.mp3'); tone(a, 440, 44100, 'libmp3lame')
    const b = path.join(dir, 'b.m4a'); tone(b, 880, 32000, 'aac', ['-f', 'ipod'])
    const c = path.join(dir, 'c.m4a'); tone(c, 660, 44100, 'aac', ['-f', 'ipod'])
    const total = await stitch(dir, [a, b, c])
    assert.ok(Math.abs(total - 9) < 0.15, `stitched ${total} s, expected ~9`)
  })

  test('a list that is already uniform is left alone: same paths, nothing re-encoded', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'concat-uniform-'))
    const a = path.join(dir, 'a.m4a'); tone(a, 440, 44100, 'aac', ['-f', 'ipod'])
    const b = path.join(dir, 'b.m4a'); tone(b, 660, 44100, 'aac', ['-f', 'ipod'])
    const result = await homogenizeForConcat([a, b], path.join(dir, 'norm'))
    assert.deepEqual(result, { files: [a, b], reencoded: 0 })
  })

  test('MP3s at different sample rates are left alone and still stitch to the sum', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'concat-mp3-'))
    const a = path.join(dir, 'a.mp3'); tone(a, 440, 44100, 'libmp3lame')
    const b = path.join(dir, 'b.mp3'); tone(b, 660, 24000, 'libmp3lame')
    const result = await homogenizeForConcat([a, b], path.join(dir, 'norm'))
    assert.deepEqual(result, { files: [a, b], reencoded: 0 })
    assert.ok(Math.abs(await stitch(dir, [a, b]) - 6) < 0.1)
  })

  test('one file and an empty list need no probing', async () => {
    assert.deepEqual(await homogenizeForConcat([], '/nonexistent'), { files: [], reencoded: 0 })
    assert.deepEqual(await homogenizeForConcat(['/nonexistent/x.mp3'], '/nonexistent'), { files: ['/nonexistent/x.mp3'], reencoded: 0 })
  })

  test('probeAudioSignature names codec, rate and channels, and is null for a non-audio file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'concat-probe-'))
    const a = path.join(dir, 'a.m4a'); tone(a, 440, 44100, 'aac', ['-f', 'ipod'])
    assert.equal(await probeAudioSignature(a), 'aac,44100,1')
    const junk = path.join(dir, 'junk.mp3'); await writeFile(junk, 'not audio')
    assert.equal(await probeAudioSignature(junk), null)
  })
})

describe('narration with chapter gaps', () => {
  test('a WAV chapter imported under an .mp3 name does not drop the rest of the narration', async () => {
    const { prepareNarrationWithGaps } = await import('../generators/video.js')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'narration-gap-'))
    const wavAsMp3 = path.join(dir, 'ch1.mp3'); tone(wavAsMp3, 300, 44100, 'pcm_s16le', ['-f', 'wav'])
    const real = path.join(dir, 'ch2.mp3'); tone(real, 500, 44100, 'libmp3lame')
    const job: any = { output_lines: [] }
    const out = await prepareNarrationWithGaps([wavAsMp3, real], 1, dir, job)
    assert.ok(Math.abs(seconds(out) - 7) < 0.2, `assembled ${seconds(out)} s, expected ~7 (3 + 1 gap + 3)`)
    assert.match(job.output_lines.join('\n'), /re-encoded/)
  })

  test('ordinary MP3 chapters keep the direct path (nothing re-encoded) and repeat the same gap clip', async () => {
    const { prepareNarrationWithGaps } = await import('../generators/video.js')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'narration-gap-'))
    const chapters = ['a', 'b', 'c'].map(n => path.join(dir, `${n}.mp3`))
    chapters.forEach((c, i) => tone(c, 300 + i * 100, 24000, 'libmp3lame'))
    const job: any = { output_lines: [] }
    const out = await prepareNarrationWithGaps(chapters, 1, dir, job)
    assert.ok(Math.abs(seconds(out) - 11) < 0.25, `assembled ${seconds(out)} s, expected ~11`)
    assert.doesNotMatch(job.output_lines.join('\n'), /re-encoded/)
  })
})
