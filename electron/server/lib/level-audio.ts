/**
 * Level a mix to the loudness target and check its peak as it ships (1.4.281: shared by Audio Assembly,
 * which levels the merged master, and Video Assembly, which levels its pre-mix before any scene clip).
 */
import fs from 'fs/promises'
import path from 'path'
import { runFfmpeg } from './ffmpeg-utils.js'
import { measureLoudness, type LoudnessMeasurement } from '../generators/music-episode-build.js'
import { levelFilter, levelPlan, levelToTarget, loudnessTarget, type LevelPlan, type LoudnessTarget } from './final-loudness.js'
import { nonRetryable } from '../services/job-retry-policy.js'

/**
 * The final video's audio encode (buildEncoderArgs). 384 kbit/s is YouTube's recommended stereo AAC rate
 * (1.4.281): at 192k the encoder's noise lifted the true peak of dense, noise-like beds 2–4 dB over the
 * WAV (Night Atlas Nature EP0005: +2.5 dBTP from a mix limited to -1.3), which no limiter can hold.
 */
export const FINAL_AAC_ARGS = ['-c:a', 'aac', '-b:a', '384k']

/**
 * Measure, plan, write, encode as the final does, measure again, correct (levelToTarget). `write(level)`
 * writes `output` with `level` ('' = untouched, else a filter chain ending in a comma) before its
 * output format. `plan` starts from an already-settled plan instead of the measured one. Throws when
 * no attempt is within the allowance; returns the plan of the attempt kept (null = left as it was).
 */
export async function levelAndCheck(opts: {
  measured: LoudnessMeasurement
  write: (level: string) => Promise<unknown>
  output: string
  loudness: LoudnessTarget
  format?: string
  tempDir: string
  lines: string[]
  what: string
  plan?: LevelPlan | null
}): Promise<LevelPlan | null> {
  const { measured, write, output, loudness, lines } = opts
  const plan = levelPlan(loudness, measured) && (opts.plan ?? levelPlan(loudness, measured))
  if (!plan) {
    await write('')
    lines.push(`Loudness: the ${opts.what} is silent or could not be measured, so its level was left as it is.`)
    return null
  }
  const gain = (db: number) => `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
  const said = (m: LoudnessMeasurement) => `${m.lufs?.toFixed(1) ?? '?'} LUFS, peak ${m.true_peak_db?.toFixed(1) ?? '?'} dBTP`
  const how = (p: LevelPlan) => (p.limit_db === null ? `${gain(p.gain_db)}` : `${gain(p.gain_db)} with a ${p.limit_db.toFixed(1)} dBTP limiter`)
    + (p.trim_db ? `, then ${gain(p.trim_db)} after it` : '')
  lines.push(`Loudness: the ${opts.what} measured ${said(measured)}; target ${loudness.lufs} LUFS with a ${loudness.true_peak_db} dBTP ceiling; `
    + (opts.plan ? `using the level already settled (${how(plan)}).`
      : plan.gain_db === 0 && plan.limit_db === null ? 'already within the allowance, so its level is not changed; checking its peak once encoded.'
        : plan.limit_db === null ? `one volume change of ${gain(plan.gain_db)}.`
          : `${gain(plan.gain_db)} and a peak limiter (one volume change alone would push the peaks over the ceiling).`))
  // Measured as it ships: the final AAC (Opus for webm) encode lifts true peaks, so a WAV limited to -1.3 dBTP
  // came out at -0.6 dBTP (CJ0027, 1.4.273). Correct until within the allowance and keep the closest attempt (1.4.275).
  const check = path.join(opts.tempDir, opts.format === 'webm' ? 'level_check.webm' : 'level_check.m4a')
  const kept = `${output}.kept`
  const codec = opts.format === 'webm' ? ['-c:a', 'libopus'] : FINAL_AAC_ARGS
  const { attempts, best, issue } = await levelToTarget(plan, loudness, async (p, n) => {
    await write(`${levelFilter(p)},`)
    await runFfmpeg(['-y', '-i', output, '-vn', ...codec, check])
    const got = await measureLoudness(check)
    lines.push(`Loudness: attempt ${n}${n === 1 ? '' : ` (corrected to ${how(p)})`} came out at ${said(got)} once encoded.`)
    return got
  }, () => fs.rename(output, kept))
  await fs.rename(kept, output)
  await fs.rm(check, { force: true })
  const n = attempts.indexOf(best) + 1
  if (issue) {
    throw nonRetryable(new Error(`The ${opts.what} could not be brought to its target level: ${issue} (closest of ${attempts.length} attempts, `
      + `attempt ${n}; all: ${attempts.map(a => said(a.got)).join(' / ')}). Send the job log to support.`))
  }
  if (n < attempts.length) lines.push(`Loudness: kept attempt ${n} (${said(best.got)}), the closest to the target.`)
  return best.plan
}

/** Where Audio Assembly keeps the levelled lossless master of `X.mp3` (1.4.281): `X.master.flac`. */
export function mergedAudioMasterPath(mp3: string): string {
  return `${mp3.replace(/\.mp3$/i, '')}.master.flac`
}

/**
 * The lossless master of a merged MP3, when that MP3 is the one its Audio Assembly recorded with it
 * (`{code}_merged_audio.completion.json`: same file name and size, and a `master_filename`). Null for an
 * episode merged before 1.4.281, a Sound Design mix, or an MP3 replaced since: Video Assembly then
 * levels the MP3 itself, as before.
 */
export async function mergedAudioMaster(mp3: string, code: string): Promise<string | null> {
  try {
    const rec = JSON.parse(await fs.readFile(path.join(path.dirname(mp3), `${code}_merged_audio.completion.json`), 'utf8'))
    const master = path.join(path.dirname(mp3), String(rec.master_filename || ''))
    if (!rec.master_filename || rec.output_filename !== path.basename(mp3) || rec.bytes !== (await fs.stat(mp3)).size) return null
    return (await fs.stat(master)).size > 0 ? master : null
  } catch { return null }
}

/** The channel's loudness target: its active Video Assembly preset's export settings, else -14 LUFS / -1 dBTP / 20%. */
export async function channelLoudnessTarget(slug: string): Promise<LoudnessTarget> {
  try {
    const { findActivePreset } = await import('../routes/pipeline.js')
    const pm = await import('../services/project-manager.js')
    type Bundle = { fallback?: { export?: Record<string, unknown> } }
    const preset = findActivePreset(await pm.getConfig(slug), 'video_assembly').preset as (Bundle & { data?: Bundle }) | null
    return loudnessTarget((preset?.data?.fallback ?? preset?.fallback)?.export ?? {})
  } catch { return loudnessTarget({}) }
}
