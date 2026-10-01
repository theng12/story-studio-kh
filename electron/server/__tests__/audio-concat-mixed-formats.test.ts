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
