/**
 * Intro lead-in detection for subtitle timing (v1.0.398).
 *
 * Audio Assembly can start the merged track with non-narration audio before
 * the voice begins — a prepended intro file + gap, OR (v1.0.397) a background
 * music "lead-in" that delays the narration via adelay. Either way the merged
 * audio your video uses starts the narration a few seconds in. But subtitle
 * timelines built from the CLEAN per-chapter narration (the stitched SRT, the
 * chapters-derived SRT) start at t=0 — so the burned captions run AHEAD of the
 * video by exactly the lead-in. That's the "I added an intro and the subtitles
 * are now mismatched" report.
 *
 * The merge has no outro / trailing pad (music after narration is trimmed), so
 * the lead-in is simply:  mergedDuration − narrationExtent, where
 * narrationExtent = Σ section durations + (n−1) inter-section gaps. Section
 * durations already fold in inter-part chunk silences (audio_chapters.json,
 * v1.0.317). This is agnostic to HOW the lead-in was produced (intro file or
 * music lead-in) — it measures the real offset the narration starts at.
 *
 * Read-only against the merged file + the audio_chapters.json sidecar — it
 * does NOT touch the Audio Assembly / merge code.
 */

import { getAudioDuration } from './ffmpeg-utils.js'
import fs from 'fs/promises'
import path from 'path'

/** Σ section durations + (n−1) inter-section gaps. Section durations already
 *  include inter-part chunk silences (see audio-merge v1.0.317). */
export function narrationExtentSec(
  sections: Array<{ duration_s?: number }>,
  gapSec: number,
): number {
  if (!sections.length) return 0
  const sum = sections.reduce((a, s) => a + (Number(s.duration_s) || 0), 0)
  return sum + Math.max(0, sections.length - 1) * Math.max(0, gapSec)
}

/**
 * The measurement, with the ability to say "I don't know" (v1.3.2).
 *
 * `computeIntroLeadInSec` below returns 0 for both "there is no lead-in" and
 * "I could not work it out", which is exactly right for its callers — subtitle
 * timing must not shift on a guess. But v1.3.2 shows this number to the owner
 * so he can answer "is my intro in the merged audio?", and there those two
 * cases are opposites: one is the answer he wants, the other is a lie. Hence a
 * measurement that reports which it is, and one that flattens it for the
 * timing callers whose behaviour must not change.
 */
export interface IntroLeadInMeasurement {
  status: 'measured' | 'unmeasurable'
  /** Seconds. 0 when `measured` and nothing precedes the narration. */
  seconds: number
  /** Only when `unmeasurable` — a sentence fit to show the user. */
  reason?: string
}

/** Sub-0.3s is encoder padding / rounding, not an intro. */
const LEAD_IN_NOISE_SEC = 0.3

/**
 * The measurement itself, given a duration that has already been probed.
 *
 * Pure, because every caller already knows the merged file's duration (the
 * asset scanner ffprobes each audio file anyway, and the merge generator has
 * just written the file), and re-probing a 26 MB mp3 per page load buys
 * nothing. `measureIntroLeadIn` is the probing wrapper.
 */
export function introLeadInFrom(
  mergedDurationSec: number | null | undefined,
  sections: Array<{ duration_s?: number }>,
  gapSec: number,
): IntroLeadInMeasurement {
  const dur = Number(mergedDurationSec)
  if (!Number.isFinite(dur) || dur <= 0) {
    return {
      status: 'unmeasurable',
      seconds: 0,
      reason: 'the merged audio file\'s duration could not be read.',
    }
  }
  if (!sections?.length) {
    return {
      status: 'unmeasurable',
      seconds: 0,
      reason: 'the chapter-duration sidecar (audio_chapters.json) is missing, so there is nothing to measure the narration against.',
    }
  }
  const extent = narrationExtentSec(sections, gapSec)
  if (extent <= 0) {
    return {
      status: 'unmeasurable',
      seconds: 0,
      reason: 'the chapter-duration sidecar records no chapter lengths.',
    }
  }
  const lead = dur - extent
  if (lead < -LEAD_IN_NOISE_SEC) {
    // The chapters add up to MORE than the file. The sidecar was rewritten
    // after this merge (re-generated narration, a re-merge that failed), so it
    // describes a different assembly. Reporting the negative as "no intro"
    // would be a confident wrong answer.
    return {
      status: 'unmeasurable',
      seconds: 0,
      reason: 'the chapter durations add up to more than this file, so the sidecar no longer describes it.',
    }
  }
  return {
    status: 'measured',
    seconds: lead > LEAD_IN_NOISE_SEC ? Math.round(lead * 1000) / 1000 : 0,
  }
}

/** `introLeadInFrom` with the ffprobe in front of it. */
export async function measureIntroLeadIn(
  mergedAudioPath: string | null | undefined,
  sections: Array<{ duration_s?: number }>,
  gapSec: number,
): Promise<IntroLeadInMeasurement> {
  if (!mergedAudioPath) {
    return { status: 'unmeasurable', seconds: 0, reason: 'there is no merged audio file.' }
  }
  const dur = await getAudioDuration(mergedAudioPath).catch(() => undefined)
  return introLeadInFrom(dur, sections, gapSec)
}

/**
 * Seconds of non-narration audio (intro / music lead-in + its gap) prepended
 * to the merged track — the offset subtitle timelines must add so captions
 * line up with the video. Returns 0 when there's no merged audio, no
 * measurable lead-in, or on any error (so an intro-less episode is unaffected).
 */
export async function computeIntroLeadInSec(
  mergedAudioPath: string | null | undefined,
  sections: Array<{ duration_s?: number }>,
  gapSec: number,
): Promise<number> {
  const m = await measureIntroLeadIn(mergedAudioPath, sections, gapSec)
  return m.status === 'measured' ? m.seconds : 0
}

/**
 * Which files in a merge folder are actual merged AUDIO.
 *
 * Deliberately identical to `isMergedFilename` in `generators/video.ts` (the
 * asset scanner), because the timing computed here must describe the very file
 * the renderer will lay under the pictures. Two rules, both learned from a
 * shipped defect:
 *
 *  - It must END at a real audio extension. v1.3.4: this used to be
 *    `startsWith('{code}_merged_audio.')`, which also matched the
 *    `{code}_merged_audio.completion.json` record the merge has written beside
 *    the track since 2026-07-14 — and `c` sorts before `m`, so the record won.
 *    ffprobe returned nothing for a JSON file, and the lead-in silently became
 *    0 for every episode merged after that date.
 *  - It must accept the `_v2`, `_v3` … variants Audio Assembly writes in
 *    `write_mode: 'new'`. The old prefix test rejected those outright, which is
 *    the same defect one release earlier.
 */
const MERGED_AUDIO_FILENAME = /_merged_audio(?:_v\d+)?\.(?:mp3|wav|m4a)$/i

/**
 * The merged track the app treats as this episode's narration, chosen from a
 * `merged_audio_dir` listing.
 *
 * `write_mode: 'new'` can leave `{code}_merged_audio_v2.mp3` (and `_v3`…) beside
 * the original, and a reader that picks its own file answers "which narration?"
 * differently from its neighbour. Sorted by CODE UNIT, not by locale, so `.`
 * (0x2E) precedes `_` (0x5F) and the base track wins over a `_v2` — the order
 * `resolveEpisodeIntroLeadIn` has always used. It is the selection the subtitle
 * stitcher and the merged-record readers share; `scanEpisodeAssets` still orders
 * by `readdir` (documented to agree) and `describeMergedAudioOpening` matches a
 * record to one file by `output_filename`, so this is not yet the ONLY selection
 * in the codebase. Null when the folder holds none.
 */
export function selectMergedAudioFilename(entries: readonly string[], episodeCode: string): string | null {
  const code = episodeCode.toUpperCase()
  return entries
    .filter(name => !name.startsWith('.')
      && name.toLowerCase().startsWith(`${code.toLowerCase()}_`)
      && MERGED_AUDIO_FILENAME.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0] ?? null
}

/** What an episode's merge folder says about the head of its narration. */
export interface EpisodeIntroLeadIn {
  status: 'measured' | 'unmeasurable'
  /** Seconds. 0 when `measured` and nothing precedes the narration. */
  seconds: number
  /** Only when `unmeasurable` — a sentence fit to show the user. */
  reason?: string
  /** The merged file this describes, when one was found. */
  merged_filename?: string
  /**
   * `recorded` — the merge wrote down what it prepended (authoritative).
   * `measured` — no usable record; the number comes from the file's own bytes.
   */
  source?: 'recorded' | 'measured'
}

/**
 * Resolve the lead-in directly from an episode's merge folder + sidecar.
 * Shared by automatic transcription stitching, the manual Re-stitch button and
 * the YouTube chapter finaliser, so all three use identical timing.
 *
 * v1.3.4 — this returns a MEASUREMENT, not a number. It used to return
 * `Promise<number>`, and every one of its callers wrapped it in a catch that
 * turned any failure into 0. "This episode has no intro" and "I could not work
 * out whether it has one" then looked identical — to the code, to the job log
 * and to the owner — so a timeline sixteen seconds early was indistinguishable
 * from a correct one. Callers must now say which happened.
 *
 * The seconds themselves come from `describeMergedAudioOpening`, which prefers
 * what the merge WROTE DOWN over re-deriving it. That is the same function
 * Video Assembly's "is my intro in there?" row reads, so the number the owner
 * is shown before rendering and the number his captions are shifted by cannot
 * drift apart.
 */
export async function resolveEpisodeIntroLeadIn(
  episodeDir: string,
  mergedAudioDir: string,
  episodeCode: string,
): Promise<EpisodeIntroLeadIn> {
  // Never throws. Its callers used to wrap it in `.catch(() => 0)`, and those
  // catches are gone — but the reason they existed is still valid: a subtitle
  // stitch must not be BLOCKED because the intro could not be worked out. So
  // the failure mode moves inside, where it can be reported honestly instead
  // of collapsing into a number that also means "no intro".
  try {
    return await resolveEpisodeIntroLeadInUnsafe(episodeDir, mergedAudioDir, episodeCode)
  } catch (e: any) {
    return {
      status: 'unmeasurable',
      seconds: 0,
      reason: `the intro could not be worked out (${e?.message || String(e)}).`,
    }
  }
}

async function resolveEpisodeIntroLeadInUnsafe(
  episodeDir: string,
  mergedAudioDir: string,
  episodeCode: string,
): Promise<EpisodeIntroLeadIn> {
  const code = episodeCode.toUpperCase()
  const entries = await fs.readdir(mergedAudioDir).catch(() => [] as string[])
  // ONE selection (see `selectMergedAudioFilename`): the base track wins over a
  // `_v2` by code-unit order, so every reader agrees which merge is the narration.
  const mergedName = selectMergedAudioFilename(entries, code)
  if (!mergedName) {
    return {
      status: 'unmeasurable',
      seconds: 0,
      reason: `no merged audio file for ${code} was found in ${mergedAudioDir}.`,
    }
  }

  const mergedPath = path.join(mergedAudioDir, mergedName)
  const { describeMergedAudioOpening } = await import('../services/merged-audio-opening.js')
  const opening = await describeMergedAudioOpening({
    mergedDir: mergedAudioDir,
    code,
    filename: mergedName,
    mergedDurationSec: await getAudioDuration(mergedPath).catch(() => undefined),
    episodeDir,
  })

  if (opening.source === 'unmeasurable' || opening.lead_in_sec === null) {
    return {
      status: 'unmeasurable',
      seconds: 0,
      reason: opening.reason || 'the opening of the merged audio could not be measured.',
      merged_filename: mergedName,
    }
  }
  return {
    status: 'measured',
    seconds: Math.max(0, opening.lead_in_sec),
    merged_filename: mergedName,
    source: opening.source,
  }
}

/** One line describing a lead-in, for a job log or a toast. */
export function describeEpisodeIntroLeadIn(lead: EpisodeIntroLeadIn): string {
  if (lead.status === 'unmeasurable') {
    return `Intro lead-in: NOT MEASURED — ${lead.reason} `
      + 'The timeline starts at zero; if this episode\'s merged audio does begin with an intro, '
      + 'the captions will run ahead of the video by its length. Re-merge the audio in Audio Assembly to record it.'
  }
  if (lead.seconds <= 0) {
    return `Intro lead-in: none — nothing plays before the narration in ${lead.merged_filename}, `
      + 'so the timeline starts at zero.'
  }
  return `Intro lead-in: ${lead.seconds.toFixed(3)}s applied `
    + `(${lead.source === 'recorded' ? 'recorded by the merge' : 'measured from the file'}`
    + `, ${lead.merged_filename}).`
}

/**
 * Where the STORY begins on the final video / stitched-SRT timeline (v1.0.423).
 *
 * Sleep-story episodes bundle the welcome / context / CTA / breathing into a
 * leading audio chapter literally named "Introduction". That chapter is spoken
 * narration (so it IS transcribed and DOES produce subtitle cues + would be
 * planned into scenes), but it's not story. To skip it everywhere consistently
 * we need ONE timeline position: the moment the first story chapter starts.
 *
 * This mirrors the subtitle-stitcher's cursor math EXACTLY (cursor = leadIn,
 * then per section `cursor += duration_s + gap`), so the value lines up with
 * both the stitched SRT cue timestamps (→ scene-plan skip) and video time
 * (→ title-card hold + intro-caption trim). Returns null when there's no
 * section matching "Introduction" — callers then apply no skip.
 */
export async function computeStoryStartSec(
  mergedAudioPath: string | null | undefined,
  sections: Array<{ slug?: string; duration_s?: number }>,
  gapSec: number,
): Promise<{ story_start_sec: number; intro_index: number; intro_label: string } | null> {
  if (!sections?.length) return null
  // Strict "Introduction" first; fall back to any leading "*intro*" slug.
  let introIndex = sections.findIndex(s => /^introduction$/i.test(s.slug || ''))
  if (introIndex < 0) introIndex = sections.findIndex(s => /intro/i.test(s.slug || ''))
  if (introIndex < 0) return null
  const leadIn = await computeIntroLeadInSec(mergedAudioPath, sections, gapSec)
  const gap = Math.max(0, gapSec)
  // Walk to the START of the section AFTER the Introduction — i.e. the first
  // story chapter — which equals the cursor after adding the intro's duration
  // and its trailing gap. Same accumulation the stitcher uses.
  let cursor = leadIn
  for (let i = 0; i <= introIndex; i++) {
    cursor += (Number(sections[i]?.duration_s) || 0) + gap
  }
  return {
    story_start_sec: Math.round(cursor * 1000) / 1000,
    intro_index: introIndex,
    intro_label: sections[introIndex]?.slug || 'Introduction',
  }
}

/**
 * Seconds a Scene Plan must move to sit on the merged audio's clock (1.4.272).
 *
 * A plan is cut from the stitched transcript, so a plan built after the merge
 * already carries the lead-in, and its last scene ends where the merged audio
 * ends. A plan built BEFORE a music lead-in was added (every Pipeline merge
 * before 1.4.270) was timed from narration at 0 s, so it ends exactly the
 * lead-in short of the merged audio. That tail is the evidence: shift only when
 * it matches the lead-in the merge itself recorded (never the current preset).
 * Any other tail is left alone and the coverage check judges it as before.
 */
export function scenePlanLeadInShiftSec(
  scenes: Array<{ end_sec: number }>,
  mergedLeadInSec: number | null | undefined,
  mergedDurationSec: number | null | undefined,
): number {
  const lead = Number(mergedLeadInSec)
  const duration = Number(mergedDurationSec)
  if (!scenes.length || !Number.isFinite(lead) || lead < 0.05 || !Number.isFinite(duration)) return 0
  const tail = duration - Math.max(...scenes.map(scene => Number(scene.end_sec) || 0))
  return Math.abs(tail - lead) <= 1 ? Math.round(lead * 1000) / 1000 : 0
}

/** Every scene moves by the lead-in; the first keeps its start, so its picture shows during the intro. */
export function shiftScenesForLeadIn<T extends { start_sec: number; end_sec: number }>(scenes: T[], shiftSec: number): T[] {
  if (!(shiftSec > 0)) return scenes
  return scenes.map((scene, index) => ({
    ...scene,
    start_sec: index === 0 ? scene.start_sec : scene.start_sec + shiftSec,
    end_sec: scene.end_sec + shiftSec,
  }))
}
