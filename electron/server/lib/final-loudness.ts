/**
 * Final-video loudness (owner decision 2026-10-09, "-14 LUFS, all channels"): video assembly levels
 * the whole audio mix to a target integrated loudness with a true-peak ceiling, then checks the
 * finished video. YouTube plays at a -14 LUFS reference and never turns a quiet video up.
 */
import type { LoudnessMeasurement } from '../generators/music-episode-build.js'

/** `tolerance_pct` (1.4.274) only sets how far the finished video may miss and still pass; levelling aims exactly. */
export interface LoudnessTarget {
  lufs: number; true_peak_db: number; tolerance_pct?: number
  /** 1.4.300 — the channel's "loudness" safety check (services/safety-checks.ts). Absent = 'block'
   *  (the old behaviour); a channel's own target carries its setting, Off by default. */
  check?: 'off' | 'warn' | 'block'
}

/** Peak guard after a summing amix (normalize=0): -1 dBFS, delay-compensated, never raises the level. */
export const MIX_LIMITER = 'alimiter=limit=0.891:level=0:latency=1'

export const DEFAULT_LOUDNESS_TARGET: LoudnessTarget = { lufs: -14, true_peak_db: -1 }

/** Owner rule 2026-10-10 ("We allow 10% difference"), raised to the owner's 20% standard in 1.4.279. */
export const DEFAULT_LOUDNESS_TOLERANCE_PCT = 20

/** The request's `loudness_lufs` / `true_peak_db` / `loudness_tolerance_pct`, clamped; absent = -14 / -1 / 20%. */
export function loudnessTarget(req: { loudness_lufs?: unknown; true_peak_db?: unknown; loudness_tolerance_pct?: unknown }): LoudnessTarget {
  const pick = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
  return {
    lufs: pick(req.loudness_lufs, -30, -5, DEFAULT_LOUDNESS_TARGET.lufs),
    true_peak_db: pick(req.true_peak_db, -9, 0, DEFAULT_LOUDNESS_TARGET.true_peak_db),
    tolerance_pct: pick(req.loudness_tolerance_pct, 1, 50, DEFAULT_LOUDNESS_TOLERANCE_PCT),
  }
}

/**
 * How to bring a measured mix to the target. One volume change when it keeps the true peak under
 * the ceiling (exactly what loudnorm's linear mode does). Otherwise the same gain plus a limiter run at
 * 4x the sample rate (a true-peak limiter), with its ceiling 0.3 dB under the target to leave room for
 * the return to 44.1 kHz. Null when the mix is silent or unmeasurable. A mix already within the allowance
 * is left as it is (1.4.281): no gain, no limiter, only the check of its peak once encoded.
 *
 * `trim_db` (1.4.281) turns the level down after the limiter: the lever for an encode whose peak the
 * limiter does not hold (correctLevelPlan).
 *
 * loudnorm's own fallback (dynamic mode) was measured and rejected: on real TTS speech that needed
 * 3–6 dB of limiting it landed 2.3–3.1 LU short with peaks over the ceiling, and on peaky material it
 * barely moved the level (-28.4 → -27.9 LUFS for a -14 target). It also took 272 s on a 2.5 h mix.
 */
export interface LevelPlan { gain_db: number; limit_db: number | null; trim_db?: number }

export function levelPlan(target: LoudnessTarget, m: LoudnessMeasurement): LevelPlan | null {
  if (m.lufs === null || m.lufs <= -69 || m.true_peak_db === null) return null
  if (!finalLoudnessIssue(m, target)) return { gain_db: 0, limit_db: null }
  const gain_db = target.lufs - m.lufs
  return { gain_db, limit_db: m.true_peak_db + gain_db > target.true_peak_db ? target.true_peak_db - 0.3 : null }
}

/** The ffmpeg filter for a plan (ends with a comma-free chain; the caller adds the output format). */
export function levelFilter(plan: LevelPlan): string {
  const gain = `volume=${plan.gain_db.toFixed(2)}dB`
  const trim = plan.trim_db ? `,volume=${plan.trim_db.toFixed(2)}dB` : ''
  if (plan.limit_db === null) return gain + trim
  return `${gain},aresample=176400,alimiter=limit=${(10 ** (plan.limit_db / 20)).toFixed(4)}:level=0:latency=1:attack=1:release=50,aresample=44100${trim}`
}

/**
 * After a pass, measured as it ships (the final AAC/Opus encode, which lifts true peaks):
 * the next plan when the peak is over the ceiling (a gain-only plan gets a limiter; a limited one a lower
 * limit, with 0.1 dB to spare) or a limited pass lost loudness; null when within 0.2 LU and under the
 * ceiling, or when nothing would change. A gain-only plan that is under the ceiling already landed on target.
 *
 * The limit never goes more than 3 dB under the ceiling (1.4.275). On dense, bright material (Night Atlas
 * Nature EP0002) the encode's overshoot is not set by the limiter: limits of -1.3 / -3.9 / -4.2 dBTP came out
 * at +1.5 / -0.8 / +2.8, so the next step went to -8.1 and the mix fell to -16.0 LUFS.
 *
 * 1.4.281 — the peak comes first. Night Atlas Nature EP0005 sat at that floor for three attempts
 * (+2.5 / +1.2 / +1.0 dBTP with a -4.0 limiter) while each one raised the gain back toward -14 LUFS.
 * When the encoded peak is over the allowance and the limiter is not what holds it (no limiter, a limit
 * already at its floor, or an encode more than 1.5 dB over the limit), the whole level is turned down
 * after the limiter instead: enough to land under the ceiling while the loudness stays within its
 * allowance, and never less than what the peak allowance needs. Loudness is given up, the peak never.
 */
export function correctLevelPlan(plan: LevelPlan, target: LoudnessTarget, got: LoudnessMeasurement): LevelPlan | null {
  if (got.lufs === null || got.true_peak_db === null) return null
  const over = got.true_peak_db - target.true_peak_db
  if (over <= 0 && (plan.limit_db === null || Math.abs(got.lufs - target.lufs) <= 0.2)) return null
  const floor = target.true_peak_db - 3
  const tol = loudnessTolerance(target)
  const overAllowed = over - tol.peak_db
  const limiterHolds = plan.limit_db !== null && plan.limit_db > floor + 1e-9 && got.true_peak_db - plan.limit_db <= 1.5
  if (overAllowed > 0 && !limiterHolds) {
    const room = got.lufs - (target.lufs - tol.lu) - 0.1
    const down = Math.max(overAllowed + 0.2, Math.min(over + 0.2, room))
    return { ...plan, trim_db: (plan.trim_db ?? 0) - down }
  }
  const limit = plan.limit_db ?? target.true_peak_db - 0.3
  const next: LevelPlan = { ...plan, gain_db: plan.gain_db + target.lufs - got.lufs, limit_db: over > 0 ? Math.max(limit - over - 0.1, floor) : limit }
  // The encode is deterministic: the same plan again would only measure the same.
  return Math.abs(next.gain_db - plan.gain_db) < 0.05 && next.limit_db === plan.limit_db ? null : next
}

/** How far a measurement misses, in allowances (loudnessTolerance): 0 on target, up to 1 within it, Infinity unmeasured. */
export function loudnessMiss(m: LoudnessMeasurement, target: LoudnessTarget): number {
  if (m.lufs === null || m.true_peak_db === null) return Infinity
  const tol = loudnessTolerance(target)
  return Math.max(Math.abs(m.lufs - target.lufs) / tol.lu, (m.true_peak_db - target.true_peak_db) / tol.peak_db, 0)
}

export interface LevelAttempt { plan: LevelPlan; got: LoudnessMeasurement }

/** Closer to the target: an attempt whose peak is within the allowance beats any that is not (1.4.281), then the smaller miss. */
function closer(a: LevelAttempt, b: LevelAttempt, target: LoudnessTarget): boolean {
  if (peakWithin(a, target) !== peakWithin(b, target)) return peakWithin(a, target)
  return loudnessMiss(a.got, target) < loudnessMiss(b.got, target)
}

function peakWithin({ got }: LevelAttempt, target: LoudnessTarget): boolean {
  return got.true_peak_db !== null && got.true_peak_db <= target.true_peak_db + loudnessTolerance(target).peak_db + 1e-9
}

/**
 * Level, measure as it ships, correct: at most 4 attempts, 6 while no attempt has its peak within the
 * allowance (1.4.281), stopping at the first one within the allowance (1.4.275: no chasing an exact hit).
 * Ends on the attempt that came closest (`closer`), never a worse later one; `keep` runs whenever an attempt
 * becomes the closest so far, so the caller can keep that attempt's file.
 * `issue` is finalLoudnessIssue of that closest attempt (null = it passes).
 */
export async function levelToTarget(
  first: LevelPlan, target: LoudnessTarget,
  attempt: (plan: LevelPlan, n: number) => Promise<LoudnessMeasurement>,
  keep: () => Promise<void>,
): Promise<{ attempts: LevelAttempt[]; best: LevelAttempt; issue: string | null }> {
  const attempts: LevelAttempt[] = []
  let best: LevelAttempt | undefined
  for (let plan: LevelPlan | null = first; plan && attempts.length < (best && peakWithin(best, target) ? 4 : 6);) {
    const a: LevelAttempt = { plan, got: await attempt(plan, attempts.length + 1) }
    attempts.push(a)
    if (!best || closer(a, best, target)) { best = a; await keep() }
    plan = finalLoudnessIssue(a.got, target) ? correctLevelPlan(plan, target, a.got) : null
  }
  return { attempts, best: best!, issue: finalLoudnessIssue(best!.got, target) }
}

/**
 * How far a finished video may miss and still pass (1.4.274, owner rule 2026-10-10): the percentage of the
 * target's loudness (10% of -14 = 1.4 LU) and the same percentage in peak amplitude over the ceiling
 * (10% = +0.8 dB). Was a fixed 1 LU / +0.1 dB.
 */
export function loudnessTolerance(target: LoudnessTarget): { lu: number; peak_db: number } {
  const pct = target.tolerance_pct ?? DEFAULT_LOUDNESS_TOLERANCE_PCT
  return { lu: Math.abs(target.lufs) * pct / 100, peak_db: Math.round(200 * Math.log10(1 + pct / 100)) / 10 }
}

/** Why a finished video fails the loudness check: further off the target, or over the ceiling, than the tolerance allows. */
export function finalLoudnessIssue(m: LoudnessMeasurement, target: LoudnessTarget): string | null {
  if (m.lufs === null || m.true_peak_db === null) return 'its loudness could not be measured'
  const tol = loudnessTolerance(target)
  const pct = `${target.tolerance_pct ?? DEFAULT_LOUDNESS_TOLERANCE_PCT}%`
  // 1e-9: a reading exactly at the limit (-15.4 at -14 / 10%) passes despite float rounding.
  if (Math.abs(m.lufs - target.lufs) > tol.lu + 1e-9) return `${m.lufs.toFixed(1)} LUFS is more than the allowed ${pct} (${tol.lu.toFixed(1)} LU) from the ${target.lufs} LUFS target`
  if (m.true_peak_db > target.true_peak_db + tol.peak_db + 1e-9) return `its peak of ${m.true_peak_db.toFixed(1)} dBTP is more than the allowed ${pct} (+${tol.peak_db.toFixed(1)} dB) above the ${target.true_peak_db} dBTP ceiling`
  return null
}

/** For the log: " (within the allowed 10%)" when a passing final is not on the target as shown (0.1 LU), else "". */
export function withinToleranceNote(m: LoudnessMeasurement, target: LoudnessTarget): string {
  if (m.lufs === null || m.true_peak_db === null) return ''
  const exact = Math.abs(m.lufs - target.lufs) < 0.05 && m.true_peak_db < target.true_peak_db + 0.05
  return exact ? '' : ` (within the allowed ${target.tolerance_pct ?? DEFAULT_LOUDNESS_TOLERANCE_PCT}%)`
}
