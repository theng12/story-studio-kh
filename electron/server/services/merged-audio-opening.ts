/**
 * What is in front of the narration in a merged audio file — stated, not guessed.
 *
 * The owner's question, verbatim: *"if it already have intro included in the
 * merge audio yet or not. i don't want to findout after i've already render
 * the video."* Until v1.3.2 the only way to answer it was to play the file and
 * listen.
 *
 * ── Why this reuses `lib/intro-lead-in.ts` rather than measuring again ──
 *
 * `computeIntroLeadInSec` (v1.0.398) has always measured exactly this quantity
 * — `mergedDuration − narrationExtent` — because the subtitle stitcher needs
 * it to keep captions in sync. Building a second measurement of the same fact
 * is the drift v1.3.1 was spent fixing on the video side. So the number here
 * comes from that module's `introLeadInFrom()`, and it is the same number the
 * burned captions are shifted by.
 *
 * It deliberately does NOT go through `lib/opening-duration.ts`, v1.3.1's
 * "one definition of what precedes the scenes". That module measures the head
 * of the VIDEO (before-intro clips, branded intro video, title card,
 * after-intro clips) so the Scene Plan and the renderer agree where scene one
 * starts. This measures the head of the merged AUDIO TRACK, which is a
 * different artifact produced by a different generator at a different time —
 * an episode can have a ten-second video opening and no audio intro at all
 * (Boundful) or the reverse. `OpeningHead`'s whole design is that adding a
 * fifth bucket is a compile error at both video call sites; forcing an audio
 * intro through it would either break that guarantee or make a change to
 * Audio Assembly break the Scene Plan. Two different facts, two modules.
 *
 * ── Why the merge also records it, when it can already be measured ──
 *
 * The measurement says HOW MUCH silence-plus-something precedes the voice. It
 * cannot say WHAT: a 14s lead-in is indistinguishable from a 14s music lead-in
 * with no intro at all. The owner asked whether HIS INTRO is in there, so the
 * merge now writes down the filename and the gap (`schema_version: 2`). The
 * record supplies the identity; the measurement supplies the number and works
 * on the 393 files that were merged before the record existed.
 *
 * ── The one thing never done here ──
 *
 * The current Audio Assembly config is never consulted. It describes what is
 * set NOW; the file was made earlier and the setting may have changed since.
 * A file with no record reports what its own bytes prove and says plainly that
 * the rest was not recorded.
 */

import fs from 'fs/promises'
import path from 'path'
import { introLeadInFrom } from '../lib/intro-lead-in.js'

/** The intro the merge actually prepended, as written down at merge time. */
export interface MergedAudioIntroRecord {
  filename: string
  /** Measured from the intro file at merge time; null if the probe failed. */
  duration_sec: number | null
  gap_after_sec: number
}

export interface MergedAudioOpening {
  /**
   * - `recorded`   — the merge wrote down what it prepended. Fully answerable.
   * - `measured`   — no record; the seconds come from the file itself. Honest
   *                  about the number, silent about the cause.
   * - `unmeasurable` — neither. Say so; never render this as "no intro".
   */
  source: 'recorded' | 'measured' | 'unmeasurable'
  /** Seconds before the narration starts. Null only when `unmeasurable`. */
  lead_in_sec: number | null
  /** Only meaningful when `recorded`. Null there means: no intro was prepended. */
  intro: MergedAudioIntroRecord | null
  /** Only meaningful when `recorded`. */
  music_lead_in_sec: number | null
  /** Only set when `unmeasurable` — why, in the user's words. */
  reason: string | null
}

/** The `opening` block v1.3.2+ merges write into the completion record. */
export interface MergedAudioOpeningRecord {
  lead_in_sec: number
  intro: MergedAudioIntroRecord | null
  music_lead_in_sec: number
}

/**
 * Build the `opening` block the merge writes, at the moment it finishes.
 *
 * The seconds come from `introLeadInFrom` — the SAME function the subtitle
 * stitcher uses — applied to the file just written and the sidecar just
 * written beside it. Deriving the number independently here would create the
 * two-measurements-of-one-fact drift v1.3.1 was spent removing.
 *
 * The fallback only runs when the sidecar could not be built (its write is
 * best-effort): then the arithmetic of what this run actually prepended is
 * authoritative, it simply does not fold in encoder padding.
 */
export function buildMergedAudioOpeningRecord(opts: {
  finalDurationSec: number
  sections: Array<{ duration_s?: number }>
  gapSec: number
  intro: MergedAudioIntroRecord | null
  musicLeadInSec: number
}): MergedAudioOpeningRecord {
  const { finalDurationSec, sections, gapSec, intro, musicLeadInSec } = opts
  const measurement = introLeadInFrom(finalDurationSec, sections, gapSec)
  const leadInSec = measurement.status === 'measured'
    ? measurement.seconds
    : roundMs((intro?.duration_sec || 0) + (intro?.gap_after_sec || 0) + musicLeadInSec)
  return { lead_in_sec: leadInSec, intro, music_lead_in_sec: musicLeadInSec }
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'))
  } catch {
    return null
  }
}

function roundMs(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Describe the head of one merged audio file.
 *
 * `mergedDurationSec` is passed in rather than probed because every caller
 * already has it (the asset scanner ffprobes each audio file anyway) and a
 * second probe of a 26 MB mp3 per page load buys nothing.
 */
export async function describeMergedAudioOpening(opts: {
  /** Directory holding the merged file and its completion record. */
  mergedDir: string
  /** Episode code, e.g. `EP0047` — names the completion record. */
  code: string
  /** The merged file being described, e.g. `EP0047_merged_audio_v2.mp3`. */
  filename: string
  /** ffprobe duration of that file, when known. */
  mergedDurationSec?: number
  /** Episode directory holding `audio_chapters.json`. */
  episodeDir: string
}): Promise<MergedAudioOpening> {
  const { mergedDir, code, filename, mergedDurationSec, episodeDir } = opts

  const completion = await readJson(
    path.join(mergedDir, `${code}_merged_audio.completion.json`),
  )

  // The completion record is written once per episode code and overwritten,
  // while `write_mode: 'new'` can leave `_v2`, `_v3` beside the original. A
  // record that names a different file says nothing about this one, and using
  // it anyway would be the same confident-guess defect as reading live config.
  const recordDescribesThisFile = completion?.output_filename === filename
  const recorded: MergedAudioOpeningRecord | undefined =
    recordDescribesThisFile && completion?.opening && typeof completion.opening === 'object'
      ? completion.opening
      : undefined

  if (recorded && typeof recorded.lead_in_sec === 'number' && Number.isFinite(recorded.lead_in_sec)) {
    return {
      source: 'recorded',
      lead_in_sec: roundMs(Math.max(0, recorded.lead_in_sec)),
      intro: recorded.intro ?? null,
      music_lead_in_sec: Number(recorded.music_lead_in_sec) || 0,
      reason: null,
    }
  }

  // No usable record — fall back to measuring the file, using the same
  // function the subtitle stitcher trusts.
  const sidecar = await readJson(path.join(episodeDir, 'audio_chapters.json'))
  const measurement = introLeadInFrom(
    mergedDurationSec,
    Array.isArray(sidecar?.sections) ? sidecar.sections : [],
    typeof sidecar?.gap_duration_s === 'number' ? sidecar.gap_duration_s : 0,
  )

  if (measurement.status !== 'measured') {
    return {
      source: 'unmeasurable',
      lead_in_sec: null,
      intro: null,
      music_lead_in_sec: null,
      reason: measurement.reason || 'The opening of this file could not be measured.',
    }
  }

  return {
    source: 'measured',
    lead_in_sec: measurement.seconds,
    intro: null,
    music_lead_in_sec: null,
    reason: null,
  }
}
