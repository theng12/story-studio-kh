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
import { correctLevelPlan, finalLoudnessIssue, levelFilter, levelPlan, loudnessTarget, loudnessTolerance, withinToleranceNote } from '../lib/final-loudness.js'
import { flattenVideoAssemblyBundle } from '../routes/pipeline.js'
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
    assert.deepEqual(loudnessTarget({}), { lufs: -14, true_peak_db: -1, tolerance_pct: 10 })
    assert.deepEqual(loudnessTarget({ loudness_lufs: -16, true_peak_db: -2, loudness_tolerance_pct: 5 }), { lufs: -16, true_peak_db: -2, tolerance_pct: 5 })
    assert.deepEqual(loudnessTarget({ loudness_lufs: 3, true_peak_db: 'x', loudness_tolerance_pct: 500 }), { lufs: -5, true_peak_db: -1, tolerance_pct: 50 })
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
    assert.ok(Math.abs(next.gain_db - 10.6) < 1e-9 && Math.abs(next.limit_db! + 1.8) < 1e-9, JSON.stringify(next))
    assert.equal(correctLevelPlan(plan, t, { lufs: -14.1, true_peak_db: -1.2 }), null)
    assert.equal(correctLevelPlan({ gain_db: 10, limit_db: null }, t, { lufs: -15, true_peak_db: -3 }), null)
  })

  test('a gain-only pass whose encode lands over the ceiling gets a limiter (1.4.273)', () => {
    const t = { lufs: -14, true_peak_db: -1 }
    const next = correctLevelPlan({ gain_db: 2, limit_db: null }, t, { lufs: -14, true_peak_db: -0.6 })!
    assert.ok(Math.abs(next.gain_db - 2) < 1e-9 && Math.abs(next.limit_db! + 1.8) < 1e-9, JSON.stringify(next))
  })

  test('verification allows 10% by default (owner rule 2026-10-10): 1.4 LU at -14, peak ceiling + 0.8 dB', () => {
    const t = loudnessTarget({})
    assert.deepEqual(loudnessTolerance(t), { lu: 1.4, peak_db: 0.8 })
    assert.equal(finalLoudnessIssue({ lufs: -14.0, true_peak_db: -1.2 }, t), null)
    assert.equal(finalLoudnessIssue({ lufs: -14.9, true_peak_db: -0.4 }, t), null)
    assert.equal(finalLoudnessIssue({ lufs: -13.1, true_peak_db: -0.6 }, t), null)
    assert.equal(finalLoudnessIssue({ lufs: -15.4, true_peak_db: -0.2 }, t), null)  // exactly at the limit
    assert.match(finalLoudnessIssue({ lufs: -16, true_peak_db: -1.2 }, t)!, /-16\.0 LUFS is more than the allowed 10% \(1\.4 LU\) from the -14 LUFS target/)
    assert.match(finalLoudnessIssue({ lufs: -14, true_peak_db: 0.2 }, t)!, /peak of 0\.2 dBTP is more than the allowed 10% \(\+0\.8 dB\) above the -1 dBTP ceiling/)
    assert.match(finalLoudnessIssue({ lufs: -24.2, true_peak_db: -11.4 }, t)!, /more than the allowed 10%/)
    assert.match(finalLoudnessIssue({ lufs: null, true_peak_db: null }, t)!, /could not be measured/)
    // A tighter setting is the project's choice.
    assert.match(finalLoudnessIssue({ lufs: -14.9, true_peak_db: -1.2 }, loudnessTarget({ loudness_tolerance_pct: 5 }))!, /allowed 5% \(0\.7 LU\)/)
  })

  test('the log says plainly when a passing final is within the allowance but not on target', () => {
    const t = loudnessTarget({})
    assert.equal(withinToleranceNote({ lufs: -14.0, true_peak_db: -1.3 }, t), '')
    assert.equal(withinToleranceNote({ lufs: -14.9, true_peak_db: -0.4 }, t), ' (within the allowed 10%)')
    assert.equal(withinToleranceNote({ lufs: -14.0, true_peak_db: -0.7 }, t), ' (within the allowed 10%)')
  })

  test('a saved preset from before 1.4.274 (no allowed difference) gets the 10% default', () => {
    const flat = flattenVideoAssemblyBundle({ fallback: { export: { loudness_lufs: -14, true_peak_db: -1 } } }, 'EP0001', 'x')
    assert.equal(flat.loudness_tolerance_pct, undefined)
    assert.equal(loudnessTarget(flat).tolerance_pct, 10)
    assert.equal(loudnessTarget(flattenVideoAssemblyBundle({ fallback: { export: { loudness_tolerance_pct: 20 } } }, 'EP0001', 'x')).tolerance_pct, 20)
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

describe('the true peak holds once encoded (1.4.273)', () => {
  // CJ0027: -14.0 LUFS but -0.6 dBTP against -1. A dense mix near -15 LUFS with sharp 5 kHz bursts reproduces it:
  // the 1.4.270 levelling left the WAV at -1.2 dBTP and the AAC 192k encode lifted it to -0.6.
  test('a peaky mix encoded like the final (AAC 192k) is at or under -1.0 dBTP (real ffmpeg)', async () => {
    const video = await import('../generators/video.js')
    const narration = path.join(dir, 'peaky.wav')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=c=pink:d=10:r=44100:seed=3',
      '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.25),0.002),0.9*sin(2*PI*5000*t),0)':d=10:s=44100",
      '-filter_complex', '[0]volume=-2dB[n];[n][1]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo', '-c:a', 'pcm_s16le', narration])
    const job = { output_lines: [] as string[] } as any
    const out = await video.premixAudio({
      narrationPath: narration, narrationDuration: 10, narrationVolume: 1,
      targetDuration: 10, tempDir: dir, job, loudness: { lufs: -14, true_peak_db: -1 }, format: 'mp4',
    })
    const encoded = path.join(dir, 'peaky-final.m4a')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-c:a', 'aac', '-b:a', '192k', encoded])
    const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', encoded, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' })
    const m = parseEbur128Summary(stderr)
    console.log(`encoded peaky mix: ${m.lufs} LUFS, peak ${m.true_peak_db} dBTP | ${job.output_lines.filter((l: string) => l.startsWith('Loudness:')).join(' | ')}`)
    assert.ok(m.true_peak_db !== null && m.true_peak_db <= -1.0, `true peak ${m.true_peak_db} dBTP`)
    assert.ok(m.lufs !== null && Math.abs(m.lufs + 14) <= 1, `integrated ${m.lufs} LUFS`)
    assert.ok(job.output_lines.some((l: string) => /once encoded; correcting/.test(l)), 'the encode was measured and corrected')
  })
})
