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
import path from 'path'
import type { SrtCue } from './subtitle-builder.js'
import { scenePlanLeadInShiftSec } from './intro-lead-in.js'

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

/**
 * The end of an episode's timeline: the later of the measured narration audio and
 * the verified captions.
 *
 * ONE authority, because two writers used to answer it separately and the reader
 * then rejected the plan they had just written. DL0011 (Dreamlands): the repair
 * persisted the audio's 6083.290 s while the captions ended at 6083.292 s, so
 * `generators/scene-plan.ts` — `plan.total_duration_sec < current.last_cue_end_sec - 0.001`
 * — read the plan as not covering its own timeline, and the job became
 * non-retryable and demanded a rebuild of a plan that was already complete.
 *
 * The caption side is `stampFromCues().last_cue_end_sec` — millisecond-rounded, and
 * the MAXIMUM over every cue — because that is exactly the number the reader
 * compares against. The last cue in FILE ORDER is not the same fact: an
 * out-of-order or appended cue makes it smaller, and persisting it reproduces the
 * rejection above.
 */
export function planEndSec(audioDurationSec: number | null | undefined, cues: SrtCue[]): number {
  return Math.max(Number(audioDurationSec) || 0, stampFromCues(cues).last_cue_end_sec)
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
 * 1.4.276 — the merged narration a plan was timed against.
 *
 * The caption timeline is not the only input that can move under a plan.
 * DL0004: Chapter 01 was re-narrated and the audio re-merged after Scene Plan
 * had run (6321 s → 6377 s). The stitched captions were not re-made, so the
 * caption stamp still matched and the plan read as current while every later
 * scene trailed the narration by ~56 s. The merged track's length is the cheap
 * fact that cannot be fooled by that: it is recorded in the plan and compared.
 *
 * Same asymmetry as `compareTimeline`: a plan with no recorded length (built
 * before 1.4.276, or before any merge existed) is "not known to be stale".
 */
export const MERGED_AUDIO_TOLERANCE_SEC = 0.5

export function compareMergedAudio(
  planStamp: { duration_sec?: number } | null | undefined,
  currentSec: number | null | undefined,
  /** Seconds of music lead-in the renderer will shift the plan by (1.4.272). */
  leadInShiftSec = 0,
): TimelineDrift {
  const planned = Number(planStamp?.duration_sec)
  const now = Number(currentSec) - (Number(leadInShiftSec) || 0)
  if (!(planned > 0) || !(now > 0) || Math.abs(now - planned) < MERGED_AUDIO_TOLERANCE_SEC) {
    return { stale: false, drift_sec: null, reason: '' }
  }
  const delta = Math.round((now - planned) * 10) / 10
  return {
    stale: true,
    drift_sec: null,
    reason: `the merged narration was ${planned.toFixed(1)}s when this plan was built and is now ${now.toFixed(1)}s `
      + `(${delta > 0 ? '+' : ''}${delta.toFixed(1)}s), so its scene times follow the old audio. `
      + 'Re-stitch the subtitles and rebuild the Scene Plan timeline.',
  }
}

/**
 * The merge's own completion record: the NARRATION's length and where it starts.
 * Null when absent.
 *
 * `duration_sec` is the narration, not the file: a merge that baked a closing
 * music tail records it separately (`closing_tail_sec`, returned here too) and
 * the tail is subtracted. Every reader of this function means the speech.
 *
 * `expectedFilename` is the merged track the caller treats as this episode's
 * narration (see `selectMergedAudioFilename`). `write_mode: 'new'` leaves
 * `{code}_merged_audio_v2.mp3` beside the base while the record is written once
 * per code and OVERWRITTEN, so it can describe a `_v2` the rest of the app does
 * not select — the same misattribution `describeMergedAudioOpening` guards
 * against. When the record names a different file it says nothing about this
 * one, so it is ignored (null) rather than compared against the wrong track.
 * Omit `expectedFilename` only when the caller genuinely does not know which
 * file it is asking about.
 */
export async function readMergedAudioRecord(
  completionPath: string,
  expectedFilename?: string | null,
): Promise<{ duration_sec: number; lead_in_sec: number; closing_tail_sec: number } | null> {
  try {
    const fs = await import('fs/promises')
    const record = JSON.parse(await fs.readFile(completionPath, 'utf-8'))
    if (expectedFilename && typeof record?.output_filename === 'string'
      && record.output_filename !== expectedFilename) return null
    const duration = Number(record?.duration_sec)
    if (!(duration > 0)) return null
    // The record's `duration_sec` is the whole file, closing music tail and all.
    // Every reader here asks how long the NARRATION is — the plan's clock, the
    // coverage check, the drift comparison — so the tail the merge baked is
    // subtracted, and a plan built before a tail was added stays current.
    const closingTailSec = Math.max(0, Number(record?.closing_tail_sec) || 0)
    return {
      duration_sec: Math.max(0, duration - closingTailSec),
      lead_in_sec: Number(record?.opening?.lead_in_sec) || 0,
      closing_tail_sec: closingTailSec,
    }
  } catch {
    return null
  }
}

/**
 * 1.4.288 — how long the current narration is: the merge's record, else the caption stitch's
 * record (merges older than the completion record have only that). Null when neither exists.
 */
export async function readNarrationRecord(
  mergedCompletionPath: string,
  stitchedMetaPath: string,
  expectedMergedFilename?: string | null,
): Promise<{ duration_sec: number; lead_in_sec: number } | null> {
  const merged = await readMergedAudioRecord(mergedCompletionPath, expectedMergedFilename)
  if (merged) return merged
  try {
    const fs = await import('fs/promises')
    const meta = JSON.parse(await fs.readFile(stitchedMetaPath, 'utf-8'))
    const duration = Number(meta?.total_duration_sec)
    return duration > 0 ? { duration_sec: duration, lead_in_sec: Number(meta?.lead_in_sec) || 0 } : null
  } catch {
    return null
  }
}

/**
 * 1.4.288 — seconds of narration after the plan's last scene, on the merged clock.
 *
 * Abiding Faith EP0136 had a plan built from 514 s of captions; the narration was
 * redone to 1505 s and nothing said so until Video Assembly ("984.1s of narration
 * has no planned scene"). The plan's own `total_duration_sec` cannot show this,
 * because it is the plan's idea of the length, so the current narration is asked.
 * 0 when there is nothing to compare against.
 */
export function planNarrationShortfallSec(
  scenes: Array<{ end_sec: number }> | undefined,
  narration: { duration_sec: number; lead_in_sec?: number } | null | undefined,
): number {
  const duration = Number(narration?.duration_sec)
  if (!Array.isArray(scenes) || !scenes.length || !(duration > 0)) return 0
  const lastEnd = Math.max(...scenes.map(scene => Number(scene?.end_sec) || 0))
  return Math.max(0, duration - lastEnd - scenePlanLeadInShiftSec(scenes, narration?.lead_in_sec, duration))
}

/** A parsed plan against the merge's completion record; null when the record is absent. */
export async function planMergedAudioDrift(
  plan: { source_merged_audio?: { duration_sec?: number }; scenes?: Array<{ end_sec: number }> },
  mergedAudioCompletionPath: string,
  expectedMergedFilename?: string | null,
): Promise<TimelineDrift | null> {
  const merged = await readMergedAudioRecord(mergedAudioCompletionPath, expectedMergedFilename)
  if (!merged) return null
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : []
  return compareMergedAudio(plan.source_merged_audio, merged.duration_sec,
    scenePlanLeadInShiftSec(scenes, merged.lead_in_sec, merged.duration_sec))
}

/**
 * Does a plan's recorded caption stamp still describe this episode's narration?
 *
 * The ONE predicate for that question, because a plan can be checked from two
 * directions and they must never disagree. The answer is "current" when EITHER
 * representation of the timeline matches the stamp: the transcript planning reads
 * today (the corrected file while its own sidecar still describes the current
 * stitch, else the raw stitch — see `planningTranscriptPath`) and the raw stitch
 * itself.
 *
 * ── Why not the planning transcript alone ──
 *
 * The corrected pass does not only rewrite words: it DROPS hallucinated cues, so
 * the two files are different cue SETS of one narration. A plan built while the
 * correction was absent or refused records the RAW stitch as its timeline; read
 * later against the corrected file alone it looks moved, and the caller re-anchors
 * every scene's timing on a timeline that has not shifted. Domnak DM0012/13/14
 * (612 raw cues against a stamp of 609, 1013/1008, 1005/999) parked on exactly
 * that, on both the recovery reader and the Scene Plan continuation.
 *
 * `current` and `raw` may be the same stamp (when planning reads the raw stitch
 * itself); either may be null when that file is unreadable. With neither
 * readable there is nothing to say, so the result is not `checked`.
 */
export function comparePlanStamp(
  stored: TimelineStamp | null | undefined,
  current: TimelineStamp | null | undefined,
  raw: TimelineStamp | null | undefined,
): TimelineDrift & { checked: boolean } {
  const judged = current ?? raw
  if (!stored?.sha256 || !judged) {
    return { checked: false, stale: false, drift_sec: null, reason: '' }
  }
  if (judged.sha256 === stored.sha256 || raw?.sha256 === stored.sha256) {
    return { checked: true, stale: false, drift_sec: null, reason: '' }
  }
  return { checked: true, ...compareTimeline(stored, judged) }
}

/**
 * The caption file planning reads TODAY for this episode: the corrected
 * transcript while its own sidecar still describes the current stitch, else the
 * raw stitch. The read-only counterpart of the resolver the Scene Plan generator
 * writes through (`resolveTranscriptSrt`) — this one never rebuilds anything.
 *
 * Falls back to the file it was handed when the episode code cannot be read back
 * off it, so a caller that passes something else keeps the old behaviour.
 */
async function planningTranscriptPath(stitchedSrtPath: string): Promise<string> {
  const dir = path.dirname(stitchedSrtPath)
  const code = /^(.+)_stitched\.srt$/i.exec(path.basename(stitchedSrtPath))?.[1]
  if (!code) return stitchedSrtPath
  const sc = await import('../services/subtitle-correction.js')
  return sc.stitchedSrtPath(dir, code) === stitchedSrtPath
    ? (await sc.inspectExistingTranscriptSource(dir, code)).path
    : stitchedSrtPath
}

/**
 * Read a stored plan and this episode's captions, and report whether the plan's
 * scene times still describe the current narration.
 *
 * Never throws: a missing plan, a missing transcript or an unreadable file all
 * mean "nothing to say", because this drives an advisory notice and an
 * exception here would take down a status endpoint.
 *
 * The comparison is against the cue boundaries the narration has NOW, in either
 * of the two representations the app keeps of them: the transcript planning
 * reads today (the corrected file while its sidecar still describes the current
 * stitch, else the raw stitch — the read-only counterpart of `resolveTranscriptSrt`)
 * and the raw stitch itself. Matching EITHER means the plan's scene times still
 * describe the narration; only when neither matches did the stitch move.
 *
 * ── Why not simply the raw stitch ──
 *
 * The corrected pass does not only rewrite words: it DROPS hallucinated cues
 * (`services/subtitle-correction.ts`), so the two files are different cue SETS of
 * one narration — and Scene Plan is built from the corrected one
 * (`source_stitched_srt`, `generators/scene-plan.ts`). Comparing a plan against
 * the raw file therefore reported drift on a stitch that had not moved since the
 * plan was built: Domnak DM0012/13/14 (612 cues against a stamp of 609, 1013/1008,
 * 1005/999), each with `generated_at` newer than the stitched file's own. The
 * recovery plan parked on "Waiting for Scene Plan" forever, on a timeline that
 * was current.
 */
export async function inspectPlanTimelineDrift(
  planPath: string,
  stitchedSrtPath: string,
  /** 1.4.276 — `{CODE}_merged_audio.completion.json`; also compares the merged narration length. */
  mergedAudioCompletionPath?: string,
  /** The merged track this episode renders with (see `selectMergedAudioFilename`). */
  expectedMergedFilename?: string | null,
): Promise<(TimelineDrift & { checked: boolean })> {
  const nothing = { checked: false, stale: false, drift_sec: null, reason: '' }
  try {
    const fs = await import('fs/promises')
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    let captions: (TimelineDrift & { checked: boolean }) = nothing
    const stored = plan?.source_timeline as TimelineStamp | undefined
    if (stored?.sha256) {
      try {
        const { parseSrt } = await import('./subtitle-builder.js')
        const stampOf = async (file: string) => stampFromCues(parseSrt(await fs.readFile(file, 'utf-8')))
        const current = await stampOf(await planningTranscriptPath(stitchedSrtPath)).catch(() => null)
        const raw = await stampOf(stitchedSrtPath).catch(() => null)
        captions = comparePlanStamp(stored, current, raw)
      } catch { /* no stitched transcript: nothing to say about captions */ }
    }
    if (captions.stale || !mergedAudioCompletionPath || !plan?.source_merged_audio) return captions
    const audio = await planMergedAudioDrift(plan, mergedAudioCompletionPath, expectedMergedFilename)
    return audio ? { checked: true, ...audio } : captions
  } catch {
    return nothing
  }
}
