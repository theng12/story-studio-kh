/**
 * 1.4.270 — background music is one steady level (owner: it must never startle a sleeping listener).
 * Real ffmpeg: tracks 12 dB apart come out within 1 LU, a swelling track ends with LRA <= 6, and
 * joins (and the loop point) are crossfaded rather than cut.
 */

import { before, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { parseEbur128Summary } from '../generators/music-episode-build.js'

let dir: string
let cleanup: () => Promise<void>
let bed: typeof import('../lib/music-bed.js')
before(async () => {
  ({ dir, cleanup } = await useTempDataDir())
  bed = await import('../lib/music-bed.js')
})
after(async () => { await cleanup() })

const make = (name: string, lavfi: string, af = 'anull') => {
  const out = path.join(dir, name)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', lavfi, '-af', `${af},aformat=channel_layouts=stereo`, out])
  return out
}
const loudness = (file: string) => parseEbur128Summary(spawnSync('ffmpeg',
  ['-hide_banner', '-nostdin', '-i', file, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)
/** Mean level (dB) of one frequency band in a window. */
const band = (file: string, start: number, freq: number) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-ss', String(start), '-t', '0.5', '-i', file,
    '-af', `bandpass=f=${freq}:width_type=q:w=8,bandpass=f=${freq}:width_type=q:w=8,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' })
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? -120)
}

describe('every music track is levelled to one reference', () => {
  test('two tracks 12 dB apart end within 1 LU of each other, near -20 LUFS, and are cached', async () => {
    const loud = make('loud.wav', 'anoisesrc=color=pink:a=0.25:d=20:seed=1', 'lowpass=f=2000')
    const quiet = make('quiet.wav', 'anoisesrc=color=pink:a=0.0628:d=20:seed=2', 'lowpass=f=2000')
    const before = [loudness(loud).lufs!, loudness(quiet).lufs!]
    assert.ok(Math.abs(before[0]! - before[1]! - 12) < 1, `inputs ${before}`)
    const a = await bed.levelMusicTrack(loud)
    const b = await bed.levelMusicTrack(quiet)
    const after = [loudness(a.path).lufs!, loudness(b.path).lufs!]
    console.log(`levelled: ${before.join(' / ')} LUFS -> ${after.join(' / ')} LUFS`)
    assert.ok(Math.abs(after[0]! - after[1]!) <= 1, `after ${after}`)
    assert.ok(after.every(v => Math.abs(v - bed.MUSIC_REFERENCE_LUFS) <= 1), `after ${after}`)
    assert.equal(path.dirname(a.path), bed.levelledMusicDir())
    assert.equal((await bed.levelMusicTrack(loud)).cached, true)
  })

  test('a swelling track (LRA well over 6) ends with LRA <= 6', async () => {
    // ±12 dB swells every 50 s over a chord and soft noise.
    const swell = path.join(dir, 'swell.wav')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=150', '-f', 'lavfi', '-i', 'sine=f=277:d=150',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:a=0.05:d=150:seed=3', '-filter_complex',
      "[0][1][2]amix=inputs=3:normalize=0,volume='pow(10,(-6+12*sin(2*PI*t/50))/20)':eval=frame,aformat=channel_layouts=stereo", swell])
    const raw = loudness(swell)
    const levelled = loudness((await bed.levelMusicTrack(swell)).path)
    console.log(`swelling track: LRA ${raw.lra} -> ${levelled.lra} LU, ${levelled.lufs} LUFS`)
    assert.ok(raw.lra! > 15, `raw LRA ${raw.lra}`)
    assert.ok(levelled.lra! <= 6, `levelled LRA ${levelled.lra}`)
  })
})

describe('joins and the loop point are crossfaded', () => {
  test('graph shape', () => {
    const g = bed.musicBedGraph([10, 10], 2.5)
    assert.match(g, /^\[0:a\]\[1:a\]acrossfade=d=2\.5:c1=qsin:c2=qsin\[x1\];\[x1\]asplit=3/)
    assert.match(g, /\[tail\]\[head\]acrossfade=d=2\.5/)
  })

  test('two tones overlap at the join and at the loop point; each is alone in its own middle', async () => {
    const a = make('a440.wav', 'sine=f=440:d=10')
    const b = make('b880.wav', 'sine=f=880:d=10')
    const lines: string[] = []
    const out = await bed.buildMusicBed([a, b], dir, line => lines.push(line))
    assert.ok(existsSync(out))
    // xf = min(3, 10/4) = 2.5. Cycle 17.5 s; the bed drops the first 2.5 s into the loop joint: 15 s.
    const len = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }))
    assert.ok(Math.abs(len - 15) < 0.1, `bed ${len} s`)
    const pureA = band(out, 2, 880) // track A alone: 880 Hz band is only leakage
    const pureB = band(out, 9, 440)
    const join = 10 - 1.5 * 2.5 - 0.25 // middle of the A→B crossfade, on the bed's clock
    const loop = 15 - 1.25 - 0.25 // middle of the B→A loop joint
    for (const t of [join, loop]) {
      assert.ok(band(out, t, 440) > pureB + 10 && band(out, t, 880) > pureA + 10,
        `both tones at ${t}s: 440 ${band(out, t, 440)} 880 ${band(out, t, 880)} (leak ${pureB} / ${pureA})`)
    }
    assert.ok(lines.some(l => /crossfade over 2\.5 s/.test(l)), lines.join('\n'))
  })
})
