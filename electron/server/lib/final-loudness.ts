/**
 * Final-video loudness (owner decision 2026-10-09, "-14 LUFS, all channels"): video assembly levels
 * the whole audio mix to a target integrated loudness with a true-peak ceiling, then checks the
 * finished video. YouTube plays at a -14 LUFS reference and never turns a quiet video up.
 */
import type { LoudnessMeasurement } from '../generators/music-episode-build.js'

export interface LoudnessTarget { lufs: number; true_peak_db: number }

/** Peak guard after a summing amix (normalize=0): -1 dBFS, delay-compensated, never raises the level. */
export const MIX_LIMITER = 'alimiter=limit=0.891:level=0:latency=1'

export const DEFAULT_LOUDNESS_TARGET: LoudnessTarget = { lufs: -14, true_peak_db: -1 }

/** The request's `loudness_lufs` / `true_peak_db`, clamped to what loudnorm accepts; absent = -14 / -1. */
export function loudnessTarget(req: { loudness_lufs?: unknown; true_peak_db?: unknown }): LoudnessTarget {
  const pick = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
  return {
    lufs: pick(req.loudness_lufs, -30, -5, DEFAULT_LOUDNESS_TARGET.lufs),
    true_peak_db: pick(req.true_peak_db, -9, 0, DEFAULT_LOUDNESS_TARGET.true_peak_db),
  }
}

/**
 * How to bring a measured mix to the target. One volume change when it keeps the true peak under
 * the ceiling (exactly what loudnorm's linear mode does). Otherwise the same gain plus a limiter run at
 * 4x the sample rate (a true-peak limiter), with its ceiling 0.3 dB under the target to leave room for
 * the return to 44.1 kHz. Null when the mix is silent or unmeasurable.
 *
 * loudnorm's own fallback (dynamic mode) was measured and rejected: on real TTS speech that needed
 * 3–6 dB of limiting it landed 2.3–3.1 LU short with peaks over the ceiling, and on peaky material it
 * barely moved the level (-28.4 → -27.9 LUFS for a -14 target). It also took 272 s on a 2.5 h mix.
 */
export interface LevelPlan { gain_db: number; limit_db: number | null }

export function levelPlan(target: LoudnessTarget, m: LoudnessMeasurement): LevelPlan | null {
  if (m.lufs === null || m.lufs <= -69 || m.true_peak_db === null) return null
  const gain_db = target.lufs - m.lufs
  return { gain_db, limit_db: m.true_peak_db + gain_db > target.true_peak_db ? target.true_peak_db - 0.3 : null }
}

/** The ffmpeg filter for a plan (ends with a comma-free chain; the caller adds the output format). */
export function levelFilter(plan: LevelPlan): string {
  const gain = `volume=${plan.gain_db.toFixed(2)}dB`
  if (plan.limit_db === null) return gain
  return `${gain},aresample=176400,alimiter=limit=${(10 ** (plan.limit_db / 20)).toFixed(4)}:level=0:latency=1:attack=1:release=50,aresample=44100`
}

/**
 * After a pass, measured as it ships (the final AAC/Opus encode, which lifts true peaks by up to ~1 dB):
 * the next plan when the peak is over the ceiling (a gain-only plan gets a limiter; a limited one a lower
 * limit, with 0.1 dB to spare) or a limited pass lost loudness; null when within 0.2 LU and under the
 * ceiling. A gain-only plan that is under the ceiling already landed on target.
 */
export function correctLevelPlan(plan: LevelPlan, target: LoudnessTarget, got: LoudnessMeasurement): LevelPlan | null {
  if (got.lufs === null || got.true_peak_db === null) return null
  const over = got.true_peak_db - target.true_peak_db
  if (over <= 0 && (plan.limit_db === null || Math.abs(got.lufs - target.lufs) <= 0.2)) return null
  const limit = plan.limit_db ?? target.true_peak_db - 0.3
  return { gain_db: plan.gain_db + target.lufs - got.lufs, limit_db: over > 0 ? limit - over - 0.1 : limit }
}

/** Over the ceiling by more than this fails the final check (1.4.273; was 0.5, which let -0.6 dBTP through). */
export const TRUE_PEAK_TOLERANCE_DB = 0.1

/** Why a finished video fails the loudness check: more than 1 LU off target, or the peak over ceiling + 0.1. */
export function finalLoudnessIssue(m: LoudnessMeasurement, target: LoudnessTarget): string | null {
  if (m.lufs === null || m.true_peak_db === null) return 'its loudness could not be measured'
  if (Math.abs(m.lufs - target.lufs) > 1) return `${m.lufs.toFixed(1)} LUFS is more than 1 LU from the ${target.lufs} LUFS target`
  if (m.true_peak_db > target.true_peak_db + TRUE_PEAK_TOLERANCE_DB) return `its peak of ${m.true_peak_db.toFixed(1)} dBTP is above the ${target.true_peak_db} dBTP ceiling`
  return null
}
