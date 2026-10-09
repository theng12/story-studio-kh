/**
 * 1.4.270 — final videos are levelled to -14 LUFS / -1 dBTP (owner decision 2026-10-09).
 *
 * The owner's Night Atlas finals measured -24.2 LUFS, peak -11.4 dBFS. Two causes: amix divided every
 * layer by the number of layers (a 150% voice became 75% under music), and nothing levelled the mix.
 */

import { before, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'
import { correctLevelPlan, finalLoudnessIssue, levelFilter, levelPlan, loudnessTarget } from '../lib/final-loudness.js'
import { parseEbur128Summary } from '../generators/music-episode-build.js'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let dir: string
let cleanup: () => Promise<void>
before(async () => { ({ dir, cleanup } = await useTempDataDir()) })
after(async () => { await cleanup() })

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const full = path.join(root, name)
    if (name === '__tests__' || name === 'node_modules') return []
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : []
  })
}

describe('amix keeps the volumes the settings name', () => {
  test('every amix in the server passes normalize=0', () => {
    const mixes = sourceFiles(serverDir).flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(/amix=inputs=[^`'"\]]*/g)].map(m => `${path.relative(serverDir, file)}: ${m[0]}`))
    assert.ok(mixes.length >= 4, `found ${mixes.length} amix filter(s)`)
    assert.deepEqual(mixes.filter(m => !m.includes('normalize=0')), [])
  })
})

describe('loudness settings and checks', () => {
  test('absent settings mean -14 LUFS / -1 dBTP; out-of-range values are clamped', () => {
    assert.deepEqual(loudnessTarget({}), { lufs: -14, true_peak_db: -1 })
    assert.deepEqual(loudnessTarget({ loudness_lufs: -16, true_peak_db: -2 }), { lufs: -16, true_peak_db: -2 })
    assert.deepEqual(loudnessTarget({ loudness_lufs: 3, true_peak_db: 'x' }), { lufs: -5, true_peak_db: -1 })
  })

  test('one volume change when the peak allows it, else gain plus a 4x true-peak limiter; silence is left alone', () => {
    const t = { lufs: -14, true_peak_db: -1 }
    // The owner's EP0001: -24.2 LUFS, peak -11.4 → +10.2 dB puts the peak at -1.2, under the ceiling.
    const linear = levelPlan(t, { lufs: -24.2, true_peak_db: -11.4 })!
    assert.equal(linear.limit_db, null)
    assert.ok(Math.abs(linear.gain_db - 10.2) < 1e-9)
    assert.equal(levelFilter(linear), 'volume=10.20dB')
    const limited = levelPlan(t, { lufs: -24, true_peak_db: -8 })!
    assert.equal(limited.limit_db, -1.3)
    assert.match(levelFilter(limited), /^volume=10\.00dB,aresample=176400,alimiter=limit=0\.8610:level=0:latency=1:attack=1:release=50,aresample=44100$/)
    assert.equal(levelPlan(t, { lufs: -70, true_peak_db: null }), null)
  })

  test('a limited pass is corrected for lost loudness and peak overshoot, and stops when close', () => {
    const t = { lufs: -14, true_peak_db: -1 }
    const plan = { gain_db: 10, limit_db: -1.3 }
    const next = correctLevelPlan(plan, t, { lufs: -14.6, true_peak_db: -0.6 })!
    assert.ok(Math.abs(next.gain_db - 10.6) < 1e-9 && Math.abs(next.limit_db! + 1.7) < 1e-9, JSON.stringify(next))
    assert.equal(correctLevelPlan(plan, t, { lufs: -14.1, true_peak_db: -1.2 }), null)
    assert.equal(correctLevelPlan({ gain_db: 10, limit_db: null }, t, { lufs: -15, true_peak_db: -3 }), null)
  })

  test('verification: within 1 LU and under ceiling + 0.5 passes', () => {
    const t = { lufs: -14, true_peak_db: -1 }
    assert.equal(finalLoudnessIssue({ lufs: -14.0, true_peak_db: -1.2 }, t), null)
    assert.equal(finalLoudnessIssue({ lufs: -13.1, true_peak_db: -0.6 }, t), null)
    assert.match(finalLoudnessIssue({ lufs: -24.2, true_peak_db: -11.4 }, t)!, /more than 1 LU/)
    assert.match(finalLoudnessIssue({ lufs: -14, true_peak_db: -0.3 }, t)!, /above the -1 dBTP ceiling/)
    assert.match(finalLoudnessIssue({ lufs: null, true_peak_db: null }, t)!, /could not be measured/)
  })
})

describe('a quiet narration with music comes out at -14 LUFS', () => {
  // Linear: one gain change fits under the ceiling. Peaky: short loud clicks over quiet speech, so one
  // gain would push the peaks over -1 dBTP and loudnorm has to limit them.
  for (const [name, shape] of [
    ['quiet speech (one volume change)', "volume='0.2+0.8*gt(sin(2*PI*t*3),0)':eval=frame"],
    ['quiet speech with loud clicks (peaks limited)', "volume='0.2+0.8*gt(sin(2*PI*t*3),0)+30*gt(sin(2*PI*t*0.5),0.9995)':eval=frame"],
  ] as const) {
    test(`premixAudio levels the mix: ${name} (real ffmpeg)`, async () => {
      const video = await import('../generators/video.js')
      const narration = path.join(dir, 'quiet-narration.wav')
      const music = path.join(dir, 'music.wav')
      // Speech-like: pink noise switching on and off a few times a second, around -35 LUFS.
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:a=0.03:d=8:seed=7',
        '-af', shape, '-c:a', 'pcm_f32le', narration])
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=8', music])
      const job = { output_lines: [] as string[] } as any
      const out = await video.premixAudio({
        narrationPath: narration, narrationDuration: 8, narrationVolume: 1.5,
        musicFilePath: music,
        musicConfig: { enabled: true, files: [music], volume: 0.2, post_narration_volume: 0.4, fade_in: 0, fade_out: 0 },
        targetDuration: 8, tempDir: dir, job,
        loudness: { lufs: -14, true_peak_db: -1 },
      })
      const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', out, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' })
      const m = parseEbur128Summary(stderr)
      console.log(`premix loudness (${name}): ${m.lufs} LUFS, peak ${m.true_peak_db} dBTP | ${job.output_lines.find((l: string) => l.startsWith('Loudness:'))}`)
      assert.ok(m.lufs !== null && Math.abs(m.lufs + 14) <= 1, `integrated ${m.lufs} LUFS`)
      assert.ok(m.true_peak_db !== null && m.true_peak_db <= -1, `true peak ${m.true_peak_db} dBTP`)
      assert.ok(job.output_lines.some((l: string) => /^Loudness: the mix measured -\d/.test(l)))
    })
  }
})
