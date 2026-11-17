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
import { correctLevelPlan, finalLoudnessIssue, levelFilter, levelPlan, levelToTarget, loudnessMiss, loudnessTarget, loudnessTolerance, withinToleranceNote, type LevelPlan } from '../lib/final-loudness.js'
import type { LoudnessMeasurement } from '../generators/music-episode-build.js'
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
    assert.deepEqual(loudnessTarget({}), { lufs: -14, true_peak_db: -1, tolerance_pct: 20 })
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

  test('the limit never drops more than 3 dB under the ceiling, and an unchanged plan stops (1.4.275)', () => {
    const t = { lufs: -14, true_peak_db: -1 }
    // EP0002's third pass: limited at -4.2, encoded at +2.8 → 1.4.273 went to -8.1 dBTP and the mix fell to -16.0 LUFS.
    // Within the peak allowance the limiter still does the work, and stops at its floor.
    const next = correctLevelPlan({ gain_db: 10, limit_db: -1.3 }, t, { lufs: -14.1, true_peak_db: 0.5 })!
    assert.ok(Math.abs(next.limit_db! + 2.9) < 1e-9, JSON.stringify(next))
    assert.equal(correctLevelPlan({ gain_db: 10, limit_db: -3.5 }, t, { lufs: -14.1, true_peak_db: -0.5 })!.limit_db, -4)
    assert.equal(correctLevelPlan({ gain_db: 10, limit_db: -4 }, t, { lufs: -14, true_peak_db: -0.5 }), null)
  })

  test('a peak over the allowance that the limiter does not hold turns the level down after it (1.4.281)', () => {
    const t = loudnessTarget({})  // -14 / -1 / 20%: 2.8 LU, +1.6 dB
    // At the limiter's floor: +2.8 dBTP is 3.8 over the ceiling. Landing under it would cost 4.0 dB and leave
    // -18.1 LUFS, outside the allowance; so it goes down only as far as the loudness allows (to -16.7), which
    // is still more than the peak allowance needs (2.4 dB).
    const atFloor = correctLevelPlan({ gain_db: 10, limit_db: -4 }, t, { lufs: -14.1, true_peak_db: 2.8 })!
    assert.equal(atFloor.limit_db, -4)
    assert.equal(atFloor.gain_db, 10)
    assert.ok(Math.abs(atFloor.trim_db! + 2.6) < 1e-9, JSON.stringify(atFloor))
    // No limiter (an untouched mix): a +0.8 encode needs only 2.0 dB to land under the ceiling.
    const untouched = correctLevelPlan({ gain_db: 0, limit_db: null }, t, { lufs: -14.7, true_peak_db: 0.8 })!
    assert.ok(Math.abs(untouched.trim_db! + 2.0) < 1e-9 && untouched.gain_db === 0 && untouched.limit_db === null, JSON.stringify(untouched))
    // An encode far over its limit: the encoder, not the limiter, sets that peak. The peak allowance wins over
    // the loudness one (2.1 dB down, though only 1.6 dB keeps -16.8 LUFS), and trims add up.
    const far = correctLevelPlan({ gain_db: 0.7, limit_db: -1.3, trim_db: -1 }, t, { lufs: -15.1, true_peak_db: 2.5 })!
    assert.ok(Math.abs(far.trim_db! + 3.1) < 1e-9 && far.limit_db === -1.3 && far.gain_db === 0.7, JSON.stringify(far))
    assert.equal(levelFilter(far), 'volume=0.70dB,aresample=176400,alimiter=limit=0.8610:level=0:latency=1:attack=1:release=50,aresample=44100,volume=-3.10dB')
    assert.equal(levelFilter({ gain_db: 0, limit_db: null, trim_db: -2 }), 'volume=0.00dB,volume=-2.00dB')
  })

  test('a mix already within the allowance is not turned up or limited, only checked once encoded (1.4.281)', () => {
    const t = loudnessTarget({})
    // Night Atlas Nature EP0005's mix: -14.7 LUFS, -1.1 dBTP. 1.4.280 added +0.7 dB and a limiter.
    assert.deepEqual(levelPlan(t, { lufs: -14.7, true_peak_db: -1.1 }), { gain_db: 0, limit_db: null })
    assert.equal(levelFilter(levelPlan(t, { lufs: -14.7, true_peak_db: -1.1 })!), 'volume=0.00dB')
    assert.equal(levelPlan(loudnessTarget({ loudness_tolerance_pct: 3 }), { lufs: -14.7, true_peak_db: -1.1 })!.gain_db.toFixed(1), '0.7')
  })

  test('how far a reading misses, in allowances', () => {
    const t = loudnessTarget({ loudness_tolerance_pct: 10 })
    assert.equal(loudnessMiss({ lufs: -14, true_peak_db: -2 }, t), 0)
    assert.ok(loudnessMiss({ lufs: -14.3, true_peak_db: -0.8 }, t) <= 1)
    assert.ok(Math.abs(loudnessMiss({ lufs: -16, true_peak_db: -1 }, t) - 2 / 1.4) < 1e-9)
    assert.equal(loudnessMiss({ lufs: null, true_peak_db: null }, t), Infinity)
  })

  test('verification at 10% (owner rule 2026-10-10): 1.4 LU at -14, peak ceiling + 0.8 dB', () => {
    const t = loudnessTarget({ loudness_tolerance_pct: 10 })
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

  test('verification allows 20% by default (owner standard, 1.4.279): 2.8 LU at -14, peak ceiling + 1.6 dB', () => {
    const t = loudnessTarget({})
    assert.deepEqual(loudnessTolerance(t), { lu: 2.8, peak_db: 1.6 })
    // Night Atlas Science EP0002 (assembly fb9be5b2) failed at 10% with a 0.4 dBTP peak; it passes at 20%.
    assert.match(finalLoudnessIssue({ lufs: -14.0, true_peak_db: 0.4 }, loudnessTarget({ loudness_tolerance_pct: 10 }))!, /peak of 0\.4 dBTP is more than the allowed 10%/)
    assert.equal(finalLoudnessIssue({ lufs: -14.0, true_peak_db: 0.4 }, t), null)
    assert.equal(finalLoudnessIssue({ lufs: -16.8, true_peak_db: -1 }, t), null)  // exactly at the limit
    assert.match(finalLoudnessIssue({ lufs: -17, true_peak_db: -1 }, t)!, /-17\.0 LUFS is more than the allowed 20% \(2\.8 LU\)/)
    assert.match(finalLoudnessIssue({ lufs: -14, true_peak_db: 0.7 }, t)!, /peak of 0\.7 dBTP is more than the allowed 20% \(\+1\.6 dB\)/)
  })

  test('the log says plainly when a passing final is within the allowance but not on target', () => {
    const t = loudnessTarget({})
    assert.equal(withinToleranceNote({ lufs: -14.0, true_peak_db: -1.3 }, t), '')
    assert.equal(withinToleranceNote({ lufs: -14.9, true_peak_db: -0.4 }, t), ' (within the allowed 20%)')
    assert.equal(withinToleranceNote({ lufs: -14.0, true_peak_db: -0.7 }, t), ' (within the allowed 20%)')
  })

  test('a saved preset from before 1.4.274 (no allowed difference) gets the 20% default', () => {
    const flat = flattenVideoAssemblyBundle({ fallback: { export: { loudness_lufs: -14, true_peak_db: -1 } } }, 'EP0001', 'x')
    assert.equal(flat.loudness_tolerance_pct, undefined)
    assert.equal(loudnessTarget(flat).tolerance_pct, 20)
    assert.equal(loudnessTarget(flattenVideoAssemblyBundle({ fallback: { export: { loudness_tolerance_pct: 20 } } }, 'EP0001', 'x')).tolerance_pct, 20)
  })
})

describe('the correction keeps the closest attempt (1.4.275)', () => {
  // Night Atlas Nature EP0002 on 1.4.273: +1.5 → -0.8 → +2.8 dBTP, then -16.0 LUFS and an error, though its
  // second attempt (-14.3 LUFS, -0.8 dBTP) was within the allowed 10%.
  const ep0002: LoudnessMeasurement[] = [
    { lufs: -13.9, true_peak_db: 1.5 }, { lufs: -14.3, true_peak_db: -0.8 }, { lufs: -14.1, true_peak_db: 2.8 }, { lufs: -16.0, true_peak_db: -1.5 },
  ]
  const ten = loudnessTarget({ loudness_tolerance_pct: 10 })  // these were measured against the 10% of 1.4.275
  const run = async (target: ReturnType<typeof loudnessTarget>, readings: LoudnessMeasurement[]) => {
    const tried: LevelPlan[] = []
    const kept: number[] = []
    const r = await levelToTarget({ gain_db: 10, limit_db: -1.3 }, target,
      async (plan, n) => { tried.push(plan); return readings[n - 1] },
      async () => { kept.push(tried.length) })
    return { ...r, tried, kept }
  }

  test('stops at the first attempt within the allowance: EP0002 passes with attempt 2', async () => {
    const r = await run(ten, ep0002)
    assert.equal(r.attempts.length, 2)
    assert.equal(r.best, r.attempts[1])
    assert.equal(r.issue, null)
    assert.deepEqual(r.kept, [1, 2])
    // 1.4.281: +1.5 over a -1.3 limit is the encode, not the limiter: the level goes down 1.9 dB after it.
    assert.ok(r.tried[1].limit_db === -1.3 && Math.abs(r.tried[1].trim_db! + 1.9) < 1e-9, JSON.stringify(r.tried))
  })

  test('History EP0002 (1.4.274): stops at attempt 3, within the allowance, and measures nothing after it', async () => {
    const readings = [{ lufs: -14.0, true_peak_db: 0.1 }, { lufs: -14.2, true_peak_db: 1.5 }, { lufs: -14.6, true_peak_db: -2.3 },
      { lufs: null, true_peak_db: null }]
    const r = await run(ten, readings)
    assert.equal(r.tried.length, 3)
    assert.equal(r.best, r.attempts[2])
    assert.equal(r.issue, null)
  })

  test('a later pass that cannot be measured falls back to the closest earlier attempt', async () => {
    // 1.4.274 errored "its loudness could not be measured" on such a pass. The unmeasured one is never kept.
    const readings = [{ lufs: -14.0, true_peak_db: 0.1 }, { lufs: null, true_peak_db: null }, { lufs: -14.6, true_peak_db: -2.3 }]
    const r = await run(ten, readings)
    assert.equal(r.tried.length, 2)
    assert.equal(r.best, r.attempts[0])
    assert.deepEqual(r.kept, [1])
    assert.match(r.issue!, /peak of 0\.1 dBTP is more than the allowed 10%/)
    assert.doesNotMatch(r.issue!, /could not be measured/)
  })

  test('when no attempt is within it, ends on the closest one and still fails', async () => {
    // 5%: 0.7 LU / +0.4 dB. Attempt 2 misses by 1.0 LU, the others by more; attempt 3 is worse again.
    const readings = [ep0002[0], { lufs: -15.0, true_peak_db: -0.6 }, ep0002[2], ep0002[3]]
    const r = await run(loudnessTarget({ loudness_tolerance_pct: 5 }), readings)
    assert.equal(r.attempts.length, 4)
    assert.equal(r.best, r.attempts[1])
    assert.deepEqual(r.kept, [1, 2])  // attempts 3 and 4 never replace the kept file
    assert.match(r.issue!, /-15\.0 LUFS is more than the allowed 5%/)
    assert.ok(r.tried.every(p => p.limit_db! >= -4), JSON.stringify(r.tried))
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
      assert.ok(job.output_lines.some((l: string) => /^Loudness: the audio mix measured -\d/.test(l)))
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
    const target = loudnessTarget({ loudness_tolerance_pct: 3 })
    const out = await video.premixAudio({
      narrationPath: narration, narrationDuration: 10, narrationVolume: 1,
      // 3%: the first encode (-14.6 LUFS, -0.4 dBTP) would already pass 10%, which ends the correction.
      targetDuration: 10, tempDir: dir, job, loudness: target, format: 'mp4',
    })
    const encoded = path.join(dir, 'peaky-final.m4a')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-c:a', 'aac', '-b:a', '192k', encoded])
    const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', encoded, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' })
    const m = parseEbur128Summary(stderr)
    console.log(`encoded peaky mix: ${m.lufs} LUFS, peak ${m.true_peak_db} dBTP | ${job.output_lines.filter((l: string) => l.startsWith('Loudness:')).join(' | ')}`)
    assert.equal(finalLoudnessIssue(m, target), null)
    assert.ok(job.output_lines.some((l: string) => /^Loudness: attempt 2 \(corrected to .* came out at .* once encoded\.$/.test(l)), 'the encode was measured and corrected')
  })
})

describe('the peak holds once encoded, even when the encoder overshoots (1.4.281)', () => {
  // Night Atlas Nature EP0005 (assembly ed0f10dc): the mix measured -14.7 LUFS, -1.1 dBTP. 1.4.280 added +0.7 dB
  // and a -1.3 limiter, and the AAC 192k encode came out at +2.5; the limiter went to its -4.0 floor and the
  // gain back up, and the four attempts ended at +2.5 / +2.5 / +1.2 / +1.0 dBTP: a failed job after an hour of
  // scene clips. A model of that encoder: it adds 2.9 dB to the mix's own peak whatever the limiter does.
  const mix = { lufs: -14.7, true_peak_db: -1.1 }
  const encode = (p: LevelPlan): LoudnessMeasurement => ({
    lufs: mix.lufs + p.gain_db + (p.trim_db ?? 0) - (p.limit_db === null ? 0 : 0.1),
    true_peak_db: mix.true_peak_db + p.gain_db + (p.trim_db ?? 0) + 2.9,
  })

  test('EP0005: the level goes down until the encoded peak is within the allowance, and the job passes', async () => {
    const t = loudnessTarget({})
    const first = levelPlan(t, mix)!
    const r = await levelToTarget(first, t, async p => encode(p), async () => {})
    assert.equal(r.issue, null, JSON.stringify(r.attempts))
    assert.ok(r.best.got.true_peak_db! <= t.true_peak_db + loudnessTolerance(t).peak_db, JSON.stringify(r.best))
    assert.ok(r.best.got.lufs! >= -16.8, JSON.stringify(r.best))
    assert.equal(r.attempts.length, 2)
    assert.equal(r.best.plan.gain_db, 0, 'never turned up: the mix was already within the allowance')
  })

  test('an attempt with its peak within the allowance is kept over a louder one that is not', async () => {
    const t = loudnessTarget({ loudness_tolerance_pct: 5 })  // 0.7 LU, +0.4 dB
    // Attempt 1 misses less by the old measure (1.25 allowances, all of it peak); attempt 2 misses by 1.43, all loudness.
    const readings = [{ lufs: -14.0, true_peak_db: -0.5 }, { lufs: -15.0, true_peak_db: -1.0 }, { lufs: -16.0, true_peak_db: -1.5 }, { lufs: -14.0, true_peak_db: -0.5 }]
    const r = await levelToTarget({ gain_db: 3, limit_db: -1.3 }, t, async (_p, n) => readings[n - 1]!, async () => {})
    assert.equal(r.best, r.attempts[1])
    assert.match(r.issue!, /-15\.0 LUFS is more than the allowed 5%/)
  })

  test('the final AAC is 384 kbit/s: a dense, limited bed overshoots far less than at 192 (real ffmpeg)', async () => {
    const { FINAL_AAC_ARGS } = await import('../lib/level-audio.js')
    assert.deepEqual(FINAL_AAC_ARGS, ['-c:a', 'aac', '-b:a', '384k'])
    // Rain-like: white + pink noise, limited at 4x to -1.3 dBTP. At 192k the encode lifted it about 4 dB.
    const bed = path.join(dir, 'dense-bed.wav')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=color=white:r=44100:a=0.4:d=10:seed=2',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:r=44100:a=0.4:d=10:seed=12', '-filter_complex',
      `[0][1]amerge=inputs=2,highpass=f=200,${levelFilter({ gain_db: 6, limit_db: -1.3 })}`, '-c:a', 'pcm_s16le', bed])
    const peak = (file: string) => parseEbur128Summary(spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' }).stderr).true_peak_db!
    const encoded = (args: string[]) => {
      const out = path.join(dir, `dense-${args.at(-1)}.m4a`)
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', bed, ...args, out])
      return peak(out)
    }
    const wav = peak(bed)
    const at192 = encoded(['-c:a', 'aac', '-b:a', '192k'])
    const at384 = encoded(FINAL_AAC_ARGS)
    console.log(`dense bed: WAV ${wav} dBTP, AAC 192k ${at192}, AAC 384k ${at384}`)
    assert.ok(at384 - wav <= 1.5, `384k lifted the peak ${(at384 - wav).toFixed(1)} dB`)
    assert.ok(at192 - at384 >= 1.5, `192k ${at192} vs 384k ${at384}`)
  })
})

describe('the sound is settled before the picture (1.4.281)', () => {
  test('Video Assembly levels the mix before it renders any scene clip or compilation background', () => {
    const source = readFileSync(path.join(serverDir, 'generators', 'video.ts'), 'utf8')
    const body = source.slice(source.indexOf('export async function generateVideo('))
    const early = body.indexOf('settled: plan => { settledPlan = plan }')
    assert.ok(early > 0, 'the early loudness step')
    for (const later of ['await prepareSceneClips(', 'await prepareCompilationBackground(', 'await prepareIntroClip(', 'await prepareTitleClip(']) {
      assert.ok(body.indexOf(later) > early, `${later} comes after the loudness step`)
    }
    // Both later pre-mixes start from the settled level.
    assert.equal(body.match(/plan: settledPlan/g)?.length, 2)
  })

  test('Audio Assembly writes the MP3 alone, and its level is checked as the final AAC ships it (real ffmpeg)', async () => {
    const { levelMergedAudio } = await import('../generators/audio-merge.js')
    const { FINAL_AAC_ARGS } = await import('../lib/level-audio.js')
    const { mkdir, stat } = await import('node:fs/promises')
    const merged = path.join(dir, 'merged')
    await mkdir(merged, { recursive: true })
    // A quiet narration-like mix, about -30 LUFS.
    const raw = path.join(dir, 'merged-raw.flac')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:a=0.03:d=8:seed=7',
      '-af', "volume='0.2+0.8*gt(sin(2*PI*t*3),0)':eval=frame,aformat=channel_layouts=stereo", '-c:a', 'flac', raw])
    const mp3 = path.join(merged, 'EP0001_merged_audio.mp3')
    const lines: string[] = []
    await levelMergedAudio({ raw, mp3, loudness: loudnessTarget({}), tempDir: dir, lines })
    const encoded = path.join(dir, 'mp3-final.m4a')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, ...FINAL_AAC_ARGS, encoded])
    const m = parseEbur128Summary(spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', encoded, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)
    console.log(`merged mp3 once encoded: ${m.lufs} LUFS, peak ${m.true_peak_db} dBTP | ${lines.join(' | ')}`)
    assert.equal(finalLoudnessIssue(m, loudnessTarget({})), null)
    assert.ok((await stat(mp3)).size > 0)
    // The merge's output folder holds the MP3 as its only audio file.
    assert.equal(await stat(path.join(merged, 'EP0001_merged_audio.master.flac')).catch(() => null), null)
    assert.ok(!lines.some(line => /Lossless master/i.test(line)), lines.join(' | '))
    // No reader survives the writer: neither helper is exported, and Video Assembly names no master.
    const levelAudio = readFileSync(path.join(serverDir, 'lib', 'level-audio.ts'), 'utf8')
    assert.doesNotMatch(levelAudio, /master_filename|mergedAudioMaster|master\.flac/i)
    const video = readFileSync(path.join(serverDir, 'generators', 'video.ts'), 'utf8')
    assert.doesNotMatch(video, /mergedAudioMaster|master\.flac/i)
  })
})
