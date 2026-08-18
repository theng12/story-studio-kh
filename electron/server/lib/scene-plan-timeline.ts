/**
 * Is the Scene Plan still describing the timeline it was built from? (v1.4.0)
 *
 * ── Why this exists ──
 *
 * The stitched subtitle file is not downstream of Scene Plan; it is the INPUT
 * Scene Plan is generated from. `generators/scene-plan.ts` reads the stitched
 * SRT to derive every scene's time range, and the stitch endpoint lives inside
 * the scene-plan flow.
 *
 * v1.4.0 made stitching automatic, which is safe on its own and dangerous in
 * combination: re-stitching an episode whose lead-in was previously wrong moves
 * every cue, and a scene plan built against the old timeline keeps pointing at
 * the old timing. The result would be the worst outcome available — captions
 * repaired, images still drifted, and nothing anywhere saying the two disagree.
 * That is the same "one episode, two answers" fault that caused the 1.3.4
 * incident, one layer up.
 *
 * So a re-stitch that MOVES the timeline says so, and names the drift.
 *
 * ── Why the identity hashes timings and not the file ──
 *
 * Hashing the stitched file's bytes would mark a plan stale whenever anybody
 * corrected a spelling, because the corrected-transcript pass rewrites words at
 * unchanged timings. A scene plan does not care what the words are; it cares
 * where they fall. The identity is therefore the sequence of cue boundaries and
 * nothing else, so a text correction is correctly silent and a shifted timeline
 * correctly is not.
 *
 * ── What this deliberately does NOT do ──
 *
 * It does not repair anything. Re-stitching a caption file is cheap and
 * reversible; rewriting a scene plan is not — one real episode has 124 generated
 * images hanging off its plan, and regenerating those costs actual money. So
 * this detects and reports, and a person decides. Detection alone removes the
 * silence, which is the part that matters.
 */

import { createHash } from 'crypto'
import type { SrtCue } from './subtitle-builder.js'

/** Millisecond precision — the timeline's own resolution. */
const ms = (n: number): number => Math.round((Number(n) || 0) * 1000)

/**
 * What a scene plan was built against. Small enough to sit in `scene_plan.json`
 * without bloating it, and specific enough that a moved timeline cannot match.
 */
export interface TimelineStamp {
  /** Hash of every cue boundary, in order. */
  sha256: string
  /** Cue count, so a truncated timeline is obvious in the message. */
  total_cues: number
  /** Where the first caption starts — the number that moves when the intro
   *  lead-in is corrected, and therefore the most legible drift to report. */
  first_cue_start_sec: number
  /** Where the last caption ends. */
  last_cue_end_sec: number
}

/**
 * Identity of a caption timeline: cue boundaries, and only those.
 *
 * Cues are sorted first so a re-stitch that emits the same boundaries in a
 * different order is correctly treated as the same timeline.
 */
export function timelineIdentity(cues: SrtCue[]): string {
  const rows = (cues || [])
    .map(c => `${ms(c.start_sec)}-${ms(c.end_sec)}`)
    .sort()
  return createHash('sha256').update(rows.join('|')).digest('hex')
}

export function stampFromCues(cues: SrtCue[]): TimelineStamp {
  const usable = (cues || []).filter(c => Number.isFinite(c.start_sec) && Number.isFinite(c.end_sec))
  const sorted = [...usable].sort((a, b) => a.start_sec - b.start_sec)
  return {
    sha256: timelineIdentity(usable),
    total_cues: usable.length,
    first_cue_start_sec: sorted.length ? Math.round(sorted[0]!.start_sec * 1000) / 1000 : 0,
    last_cue_end_sec: sorted.length ? Math.round(Math.max(...sorted.map(c => c.end_sec)) * 1000) / 1000 : 0,
  }
}

export interface TimelineDrift {
  /** True only when the two timelines demonstrably differ. */
  stale: boolean
  /**
   * Seconds the captions moved, when that is a single coherent shift. Null when
   * the change is not a shift (cues added or removed, or nothing recorded), so
   * a number is never invented for a change it cannot describe.
   */
  drift_sec: number | null
  /** One sentence, fit to show a person. Empty when nothing is wrong. */
  reason: string
}

/**
 * Compare the timeline a plan was built against with the one on disk now.
 *
 * A plan with NO recorded stamp reports `stale: false`. That is deliberate and
 * is the opposite of the rule used for the stitch's own fingerprint, for a
 * reason: an unknown stitch is rebuilt, which is cheap and reversible, whereas
 * telling someone their plan is stale on no evidence would push them towards
 * regenerating 124 images to fix a problem that may not exist. Absence of proof
 * is not proof here, because the remedy is expensive.
 */
export function compareTimeline(
  planStamp: TimelineStamp | null | undefined,
  current: TimelineStamp,
): TimelineDrift {
  if (!planStamp?.sha256) {
    return { stale: false, drift_sec: null, reason: '' }
  }
  if (planStamp.sha256 === current.sha256) {
    return { stale: false, drift_sec: null, reason: '' }
  }

  if (planStamp.total_cues !== current.total_cues) {
    return {
      stale: true,
      drift_sec: null,
      reason: `the transcript this plan was built from had ${planStamp.total_cues} caption(s) and now has `
        + `${current.total_cues}. The scene times were derived from the old one.`,
    }
  }

  // Same number of cues, different boundaries. When the head and the tail moved
  // by the same amount it is a shift, which is the shape a corrected intro
  // lead-in produces — and a shift can be stated as one number.
  const headShift = Math.round((current.first_cue_start_sec - planStamp.first_cue_start_sec) * 1000) / 1000
  const tailShift = Math.round((current.last_cue_end_sec - planStamp.last_cue_end_sec) * 1000) / 1000
  if (Math.abs(headShift - tailShift) < 0.05 && Math.abs(headShift) >= 0.05) {
    return {
      stale: true,
      drift_sec: headShift,
      reason: `the captions moved ${headShift > 0 ? 'later' : 'earlier'} by `
        + `${Math.abs(headShift).toFixed(2)}s after the transcript was re-stitched. `
        + 'This plan\'s scene times still follow the old timing.',
    }
  }
  return {
    stale: true,
    drift_sec: null,
    reason: 'the transcript was re-stitched and its caption timings changed. '
      + 'This plan\'s scene times were derived from the old timing.',
  }
}

/**
 * Read a stored plan and the stitched transcript, and report whether the plan's
 * scene times still describe that transcript.
 *
 * Never throws: a missing plan, a missing transcript or an unreadable file all
 * mean "nothing to say", because this drives an advisory notice and an
 * exception here would take down a status endpoint.
 *
 * The RAW stitched file is compared rather than the corrected one on purpose:
 * the corrected pass rewrites words at unchanged timings, so both carry the same
 * timeline, and reading the raw file keeps this independent of whether a
 * correction happens to exist.
 */
export async function inspectPlanTimelineDrift(
  planPath: string,
  stitchedSrtPath: string,
): Promise<(TimelineDrift & { checked: boolean })> {
  const nothing = { checked: false, stale: false, drift_sec: null, reason: '' }
  try {
    const fs = await import('fs/promises')
    const [planRaw, srtRaw] = await Promise.all([
      fs.readFile(planPath, 'utf-8'),
      fs.readFile(stitchedSrtPath, 'utf-8'),
    ])
    const stored = JSON.parse(planRaw)?.source_timeline as TimelineStamp | undefined
    if (!stored?.sha256) return nothing
    const { parseSrt } = await import('./subtitle-builder.js')
    return { checked: true, ...compareTimeline(stored, stampFromCues(parseSrt(srtRaw))) }
  } catch {
    return nothing
  }
}
