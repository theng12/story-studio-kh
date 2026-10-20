/**
 * Final check — the last thing that looks at a finished final video before it can be uploaded.
 *
 * Every gate in the pipeline was green and the output was still wrong (2026-10-19): a planned 25 s
 * music closing rendered silent, and uploads were abandoned because the file was longer than the
 * plan. Neither is visible from "the generator returned", so the finished file is measured here and
 * the verdict is stored beside it.
 *
 * Runs at the end of Video Assembly, on demand from Upload Center, and its stored verdict is what
 * the upload POST refuses on. Nothing here blocks a render forever: the verdict is a fact, and the
 * channel's `final_check` safety setting plus the caller's own acknowledgement decide what to do
 * with it (services/safety-checks.ts).
 *
 * Everything expensive is ffmpeg's own child process — `runFfmpeg`/`getMediaInfo` spawn and await,
 * so the server's event loop only ever parses a capped stderr tail. Nothing here runs synchronously
 * (the libuv-threadpool incident, services/utils.ts).
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync, rmSync, statSync, writeFileSync } from 'fs'
import { getMediaInfo } from './ffmpeg-validation.js'
import { finalDurationIssue } from './video-enabled-inputs.js'
import { EBUR128_FILTER, parseEbur128Summary } from '../generators/music-episode-build.js'
import { runFfmpeg } from './ffmpeg-utils.js'
import { logLine } from '../services/logger.js'

/** Where the verdict lives: beside the final, so it travels with the file it describes. */
export function finalCheckPath(videoPath: string): string {
  return `${videoPath}.finalcheck.json`
}

/**
 * The durable "a check was asked for" record, written before the decode starts and removed when a
 * verdict lands (or the run fails). It exists for the one case no in-process registry can cover: the
 * app quits, crashes, or is force-updated mid-decode, and a later process has to tell "the check was
 * asked for and never finished" from "nobody has ever asked about this file" (AGENTS.md §6).
 */
export function finalCheckRunMarkerPath(videoPath: string): string {
  return `${finalCheckPath(videoPath)}.running`
}

/** The identity a verdict is bound to. Same path + size + mtime test `getAudioDuration` uses. */
export interface FinalCheckFileIdentity {
  size: number
  mtime_ms: number
}

/**
 * What this render was asked to produce. Written into the sidecar with the verdict, so an on-demand
 * re-run measures against the plan the file was made for rather than against today's settings.
 */
export interface FinalCheckExpectation {
  /** What the plan adds up to: narration + opening + outro + tail. 0 = length is not checked. */
  planned_sec: number
  /**
   * The closing tail the render drew: how long it is, and how far its END sits from the video's
   * end (0 = the tail is the last thing in the file; an outro after it pushes it earlier).
   */
  tail: { sec: number; from_end_sec: number }
  /** True when the episode's config asks for closing music over that tail. */
  closing_music: boolean
  width: number
  height: number
  /** The subtitle file the episode expects burned in, or null when it asks for none. */
  subtitles_path: string | null
  /**
   * Where the spoken content stops in this file: the render's own narration end, or the merged
   * narration the episode's Scene Plan was timed against (`speechEndSecFromScenePlan`).
   *
   * Absent or 0 = nothing recorded it, which is a real answer and not "the speech ends at 0 s". A
   * render from before the final-check sidecar existed has no plan at all (Night Atlas Science
   * EP0006, 2026-10-19), and the check must not call a silence "inside the speech" when it cannot
   * say where the speech is.
   */
  speech_end_sec?: number
  /**
   * The pauses the episode's merge put between sections (`audio_chapters.json`), so a silence that
   * IS one of them is not reported as a gap in the speech. Absent = the plan is not known.
   */
  section_gaps?: PlannedSectionGaps
  /**
   * What this episode's own Video Assembly settings put AFTER the narration, beyond the closing
   * tail's own account: the outro video, the timeline clips anchored `after_scenes` / `after_outro`,
   * and the post-roll the `post_audio` block asks for. 0 or absent = none.
   *
   * Only consulted when `planned_sec` is 0 — a final whose render recorded no length at all (a file
   * from before the plan sidecar existed). The episode's chapters add up to its narration; this is
   * everything its own settings put after it, and the two together are the length such a file should
   * be. `generators/video.ts` computes the same total as `totalRenderDuration` when it renders
   * (Story Sprout SS0063, 2026-10-20: a 6000 s `after_scenes` still plus a 15 s fade post-roll).
   */
  after_narration_sec?: number
  /**
   * The branded intro clip this render drew, and where it plays. Its own black is the owner's
   * content, not a fault — see `isIntroAssetBlack`.
   */
  intro?: FinalCheckIntro
}

/**
 * The branded intro clip a render put at the head of the file, and the asset behind it.
 *
 * The owner's own intro asset carries black (Story Sprout's, measured 2026-10-20: blackdetect
 * 4.67–9.13 s), and that black is inside a file the owner made with his own settings. The window is
 * what lets the check tell THAT black from a stretch the render invented somewhere else.
 */
export interface FinalCheckIntro {
  /** The asset the intro clip was prepared from. */
  asset: string
  /** Where the clip plays in the finished file. */
  window: { start_sec: number; end_sec: number }
  /**
   * The black the ASSET itself carries, in the asset's own clock (asset 0 = `window.start_sec`).
   * `runFinalCheck` measures it and stores it with the verdict; absent = not measured yet.
   */
  black?: Array<{ start_sec: number; end_sec: number }>
}

/** Each section's length in playback order, and the pause between neighbouring sections. */
export interface PlannedSectionGaps {
  gap_sec: number
  durations_sec: number[]
}

export interface FinalCheckIssue {
  /** The check's id, so a caller can name one problem without parsing the sentence. */
  check: 'duration' | 'closing_tail' | 'black' | 'silence' | 'av' | 'subtitles' | 'resolution' | 'unreadable'
  /** One plain sentence, the same words the row shows. */
  verdict: string
}

export interface FinalCheckResult {
  checked_at: string
  file: FinalCheckFileIdentity
  expected: FinalCheckExpectation
  actual: {
    duration_sec: number
    video_sec: number | null
    audio_sec: number | null
    width: number
    height: number
    /** The closing tail's integrated loudness; null when the tail is digital silence. */
    tail_lufs: number | null
    black: Array<{ start_sec: number; end_sec: number }>
    silence: Array<{ start_sec: number; end_sec: number }>
  }
  passed: boolean
  issues: FinalCheckIssue[]
}

/** Thresholds. Every one is a knob, not a constant to edit — a real render is where they get tuned. */
export interface FinalCheckOptions {
  /** A black stretch this long or longer is a fault (blackdetect `d`). */
  black_min_sec?: number
  /** How dark counts as black (blackdetect `pix_th`). */
  black_pixel_threshold?: number
  /** A silence this long or longer inside the speech is a fault (silencedetect `d`). */
  silence_min_sec?: number
  /** How quiet counts as silence (silencedetect `n`). */
  silence_noise_db?: number
  /** How far the picture and sound clocks may differ. */
  av_tolerance_sec?: number
  /** At or below this the tail is silent. ebur128's own floor for digital silence is -70. */
  tail_silent_lufs?: number
  /** Wall-clock cap for each ffmpeg pass. */
  timeout_ms?: number
}

export const FINAL_CHECK_DEFAULTS: Required<FinalCheckOptions> = {
  black_min_sec: 2,
  black_pixel_threshold: 0.1,
  silence_min_sec: 5,
  silence_noise_db: -40,
  av_tolerance_sec: 1,
  tail_silent_lufs: -70,
  // A 2.5 h 1080p file decodes in well under a minute; this only stops a wedged process
  // holding a slot forever.
  timeout_ms: 15 * 60_000,
}

function opts(o: FinalCheckOptions): Required<FinalCheckOptions> {
  return { ...FINAL_CHECK_DEFAULTS, ...o }
}

/**
 * How close to the file's own end a silence has to finish to read as the ending rather than as a gap.
 *
 * Not exact on purpose: a container's duration outlasts its last audio sample (EP0006: 9149 s of
 * picture, 9148.98 s of sound), and a picture that stops a frame or two late is not a fault.
 */
const SPEECH_END_MARGIN_SEC = 1

/**
 * The longest silent ending the check reads as "the video ending" rather than as length the video
 * should not have.
 *
 * The Video Assembly form's own longest closing tail is 45 s (`black-screen` / `hold-last-scene`), so
 * a minute covers it and the merged audio's own lead-in with room to spare. Past that a silent ending
 * is not an ending — the file is longer than it was planned to be — and `unplannedDurationIssue` says
 * so as a length fault. A video that ends in a short silence is fine and never holds (owner rule).
 */
const MAX_CLOSING_TAIL_SEC = 60

/**
 * How much of a plan-less final may sit outside the length its own episode adds up to before that
 * length is a fault: the opening before the first word, which neither the chapters nor the tail
 * settings name.
 *
 * Not a tolerance for a slightly-wrong length — the render's own plan measures that. It is the line
 * between "an opening" and "this is not the video the episode asked for": three minutes is several
 * times a branded opening put together.
 */
const UNPLANNED_LENGTH_ALLOWANCE_SEC = 180

/** The silence the file ends with, in seconds — 0 when it does not end in a measured one. */
function endingSilenceSec(actual: FinalCheckResult['actual']): number {
  const run = actual.silence.find(r => r.end_sec >= actual.duration_sec - SPEECH_END_MARGIN_SEC)
  return run ? Math.max(0, run.end_sec - run.start_sec) : 0
}

/**
 * The finished file's length against the length its own episode adds up to, for a final whose render
 * recorded no plan of its own — or null when it is the length such a file should be.
 *
 * `expectedSec` is the episode's chapters plus everything its own Video Assembly settings put after
 * them (`after_narration_sec`), and it is null only when nothing could say: no chapter plan, so no
 * narration to measure from. Only the ending is checkable then, and a silent ending far longer than
 * any closing tail is still length the file should not have.
 *
 * A silent tail is fine when the total matches — that is the whole point. Owner decision,
 * 2026-10-20, on Story Sprout SS0063's 6015 s of silence: *"yes. it's my own settings. in fact, i
 * want all already made videos to retain this."* The 100 minutes are the channel's own 6000 s
 * `after_scenes` still clip plus the 15 s fade post-roll, and a file that is what its own settings
 * asked for is not a fault. A file past them is: only ever the length it should not have.
 */
function unplannedDurationIssue(
  actualSec: number,
  expectedSec: number | null,
  endingSilence: number,
): string | null {
  const actual = Number(actualSec)
  if (expectedSec === null) {
    return endingSilence > MAX_CLOSING_TAIL_SEC
      ? `it is ${actual.toFixed(1)}s long and its last ${endingSilence.toFixed(1)}s are silent — `
        + 'far longer than any closing tail'
      : null
  }
  const over = actual - expectedSec
  return over <= UNPLANNED_LENGTH_ALLOWANCE_SEC
    ? null
    : `it is ${actual.toFixed(1)}s long but this episode's chapters and its own settings add up to `
      + `${expectedSec.toFixed(1)}s (${over > 0 ? '+' : ''}${over.toFixed(1)}s)`
}

/**
 * Where the spoken content stops in an episode's final video, from the episode's own Scene Plan.
 *
 * The plan records the merged narration it was timed against (`source_merged_audio.duration_sec`,
 * 1.4.276) and the last cue it stitched (`source_timeline.last_cue_end_sec`) — the narration end is
 * the better answer, the last cue is the fallback. This is what lets the check measure a file that
 * carries no plan of its own, instead of reporting a silence it cannot place.
 *
 * 0 when the plan cannot say. Never a guess.
 */
export function speechEndSecFromScenePlan(plan: unknown): number {
  const p = plan as {
    source_merged_audio?: { duration_sec?: unknown }
    source_timeline?: { last_cue_end_sec?: unknown }
  } | null | undefined
  const merged = Number(p?.source_merged_audio?.duration_sec)
  if (merged > 0) return merged
  const cueEnd = Number(p?.source_timeline?.last_cue_end_sec)
  return cueEnd > 0 ? cueEnd : 0
}

/** The planned pauses of an episode from its `audio_chapters.json`, or null when it plans none. */
export function plannedSectionGapsFromSidecar(sidecar: unknown): PlannedSectionGaps | null {
  const s = sidecar as { sections?: Array<{ duration_s?: unknown }>; gap_duration_s?: unknown } | null | undefined
  const gap_sec = Number(s?.gap_duration_s)
  const durations_sec = (Array.isArray(s?.sections) ? s!.sections : []).map(section => Number(section?.duration_s))
  if (!(gap_sec > 0) || durations_sec.length < 2 || !durations_sec.every(d => d > 0)) return null
  return { gap_sec, durations_sec }
}

/** Read `audio_chapters.json` from an episode folder; null when it is missing, unreadable, or plans no pause. */
export async function readPlannedSectionGaps(episodeDir: string): Promise<PlannedSectionGaps | null> {
  try {
    return plannedSectionGapsFromSidecar(JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf-8')))
  } catch {
    return null
  }
}

/**
 * The narration an episode's own chapter plan adds up to: every section's length plus the pause the
 * merge puts between neighbouring ones (`(n − 1)` pauses, which is what `sectionGapWindows` counts
 * back). Null when the plan cannot say.
 *
 * This is the one length that survives for a final whose render wrote no plan of its own — a file
 * from before the final-check sidecar existed. Without it the check has no length to measure against
 * and says nothing about a file that is minutes or hours longer than the episode it belongs to
 * (Story Sprout SS0063, 2026-10-20: 9354.2 s of file against 3329.6 s of chapters).
 */
export function plannedSecFromSectionGaps(gaps: PlannedSectionGaps | null | undefined): number | null {
  const gapSec = Number(gaps?.gap_sec)
  const durations = gaps?.durations_sec
  if (!(gapSec > 0) || !Array.isArray(durations) || durations.length < 2) return null
  if (!durations.every(d => Number.isFinite(d) && d > 0)) return null
  const total = durations.reduce((sum, d) => sum + Number(d), 0) + gapSec * (durations.length - 1)
  return Number.isFinite(total) && total > 0 ? total : null
}

/**
 * Where each planned pause sits in the file, counted BACK from where the speech stops. The lead-in
 * and any opening before the first word then cancel out, and the only number trusted is the speech
 * end the check already uses (Night Atlas History EP0014: pause after Chapter 10 at 5305.2 s).
 */
export function sectionGapWindows(
  gaps: PlannedSectionGaps,
  speechEndSec: number,
): Array<{ start_sec: number; end_sec: number }> {
  const windows: Array<{ start_sec: number; end_sec: number }> = []
  let end = speechEndSec
  for (let i = gaps.durations_sec.length - 1; i > 0; i--) {
    end -= gaps.durations_sec[i]!
    windows.push({ start_sec: end - gaps.gap_sec, end_sec: end })
    end -= gaps.gap_sec
  }
  return windows
}

/** How far a measured silence may stray from a planned pause and still be that pause (per-section rounding adds up). */
const SECTION_GAP_TOLERANCE_SEC = 1

/** The window the closing tail occupies, or null when this render drew no tail. */
export function tailWindow(
  durationSec: number,
  tail: FinalCheckExpectation['tail'],
): { start_sec: number; end_sec: number } | null {
  if (!(tail.sec > 0)) return null
  const end_sec = durationSec - Math.max(0, tail.from_end_sec || 0)
  const start_sec = end_sec - tail.sec
  return start_sec >= 0 && end_sec > start_sec ? { start_sec, end_sec } : null
}

/** How far a measured black stretch may sit from the intro asset's own black and still be it (the clip is re-encoded into the file). */
const INTRO_BLACK_TOLERANCE_SEC = 1

/**
 * True when this black stretch is the branded intro's OWN black, playing where the render put the
 * intro clip.
 *
 * Owner decision, 2026-10-20, on Story Sprout SS0063's 4.5 s black at 0:05: *"yes. it's my own
 * settings."* That black is inside the channel's own intro asset (blackdetect 4.67–9.13 s, which
 * becomes 4.75–9.208 s in the file after `prepareIntroClip`'s 24 fps encode), so it is content the
 * owner chose, not a stretch the render invented — and holding a final for it is holding it for the
 * owner's own opening.
 *
 * Both halves are required. The stretch must lie inside the intro clip's window in the FILE, and the
 * ASSET must carry black over that same stretch. Black anywhere else — a scene, a gap, an intro whose
 * asset is not black there, an asset this machine could not measure — is reported exactly as before.
 */
function isIntroAssetBlack(
  run: { start_sec: number; end_sec: number },
  intro: FinalCheckIntro | undefined,
): boolean {
  const window = intro?.window
  const assetBlack = intro?.black
  if (!window || !Array.isArray(assetBlack) || !assetBlack.length) return false
  if (!(window.end_sec > window.start_sec)) return false
  const t = INTRO_BLACK_TOLERANCE_SEC
  if (run.start_sec < window.start_sec - t || run.end_sec > window.end_sec + t) return false
  // The clip plays from the window's own start, so the asset's clock starts there.
  return assetBlack.some(black =>
    run.start_sec >= black.start_sec + window.start_sec - t
    && run.end_sec <= black.end_sec + window.start_sec + t)
}

/** `12.3` → `0:12`, `3700` → `1:01:40`. Plain clock for a plain sentence. */
function clock(sec: number): string {
  const total = Math.max(0, Math.round(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * True when this render's Video Assembly preset asks for music over the closing tail.
 *
 * Read off the raw `post_audio` block rather than through `VideoPostAudio` so this module does not
 * have to know the closing-music feature's types (it owns them; see lib/closing-tail.ts). A block
 * that is absent, or set to `volume: 0`, asks for no music — and a tail nobody asked music for is
 * allowed to be silent.
 */
export function closingMusicWanted(postAudio: unknown): boolean {
  const block = (postAudio as { closing_music?: { volume?: unknown } } | null | undefined)?.closing_music
  if (!block || typeof block !== 'object') return false
  return block.volume !== 0
}

/** blackdetect prints `black_start:1.2 black_end:3.4 black_duration:2.2`. */
export function parseBlackdetect(stderr: string): Array<{ start_sec: number; end_sec: number }> {
  const runs: Array<{ start_sec: number; end_sec: number }> = []
  for (const m of stderr.matchAll(/black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/g)) {
    const start_sec = Number(m[1])
    const end_sec = Number(m[2])
    if (Number.isFinite(start_sec) && Number.isFinite(end_sec) && end_sec > start_sec) {
      runs.push({ start_sec, end_sec })
    }
  }
  return runs
}

/**
 * silencedetect prints a `silence_start:` line, then a `silence_end: … | silence_duration: …` line.
 * A file that ends mid-silence prints only the start — that run is closed at `durationSec`, which
 * is the honest end of the file.
 */
export function parseSilencedetect(stderr: string, durationSec: number): Array<{ start_sec: number; end_sec: number }> {
  const runs: Array<{ start_sec: number; end_sec: number }> = []
  let start: number | null = null
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/)
    if (s) { start = Number(s[1]); continue }
    const e = line.match(/silence_end:\s*(-?[\d.]+)/)
    if (e && start !== null) {
      const end_sec = Number(e[1])
      if (Number.isFinite(start) && Number.isFinite(end_sec) && end_sec > start) runs.push({ start_sec: start, end_sec })
      start = null
    }
  }
  if (start !== null && durationSec > start) runs.push({ start_sec: start, end_sec: durationSec })
  return runs
}

/**
 * Every way this file misses what the plan asked for, as plain sentences. Pure — no ffmpeg, no
 * filesystem — so the verdicts are pinned by tests without generating a video for each one.
 */
export function finalCheckIssues(
  actual: FinalCheckResult['actual'],
  expected: FinalCheckExpectation,
  overrides: FinalCheckOptions = {},
): FinalCheckIssue[] {
  const o = opts(overrides)
  const issues: FinalCheckIssue[] = []
  const window = tailWindow(actual.duration_sec, expected.tail)
  // Everything before the tail is the body: speech, pictures, and any opening.
  const bodyEnd = window ? window.start_sec : actual.duration_sec

  // The length is always checked. The render's own plan is the authority when it recorded one. A
  // final from before the plan sidecar existed has none — every expected value is 0 — so the
  // episode's own chapter plan supplies the narration and its own Video Assembly settings supply
  // everything that follows it, and the file is measured against the episode it belongs to rather
  // than against nothing (Story Sprout SS0063, 2026-10-20).
  const plannedSec = Number(expected.planned_sec) > 0 ? Number(expected.planned_sec) : null
  const chaptersSec = plannedSec === null ? plannedSecFromSectionGaps(expected.section_gaps) : null
  // Without the chapters there is no narration to measure from, so there is no total to measure
  // against — a tail alone would say the file should be as long as its tail.
  const afterNarrationSec = Math.max(0, Number(expected.after_narration_sec) || 0)
  const episodeSec = chaptersSec === null ? null : chaptersSec + afterNarrationSec
  const duration = plannedSec !== null
    ? finalDurationIssue(actual.duration_sec, plannedSec)
    : unplannedDurationIssue(actual.duration_sec, episodeSec, endingSilenceSec(actual))
  if (duration) issues.push({ check: 'duration', verdict: `the finished video ${duration}` })

  if (window && expected.closing_music) {
    if (actual.tail_lufs === null || actual.tail_lufs <= o.tail_silent_lufs) {
      issues.push({
        check: 'closing_tail',
        verdict: `the closing tail (${clock(window.start_sec)} to ${clock(window.end_sec)}) is silent, `
          + `but this episode asks for closing music over it`,
      })
    }
  }

  for (const run of actual.black) {
    const length = run.end_sec - run.start_sec
    if (length < o.black_min_sec) continue
    // A black stretch inside the closing tail is the closing tail — that is what it was drawn for.
    if (run.start_sec >= bodyEnd - 0.5) continue
    // ...and a stretch inside the branded intro, which the intro's own asset is black over, is the
    // owner's opening. Only that: black anywhere else is still a fault.
    if (isIntroAssetBlack(run, expected.intro)) continue
    issues.push({
      check: 'black',
      verdict: `there is a ${length.toFixed(1)}s black stretch at ${clock(run.start_sec)}, outside the closing tail`,
    })
  }

  // Where the speech stops in this file, or null when nothing recorded it.
  //
  // The render's own recorded narration end wins when it has one: it is exact, and it sits BEFORE any
  // `after_scenes` / `after_outro` clip — which the closing tail's window starts after, because those
  // clips play between the narration and the tail. Reading the window as the speech end there put the
  // speech ~100 minutes late, and every silence after the words (a still clip is silent picture) then
  // read as a gap in them. The window is the fallback for a path that could not record the speech end
  // (a resumed final render) but does know where its tail landed — and with nothing between the two it
  // starts exactly where the speech stops.
  const recordedSpeechEnd = Number(expected.speech_end_sec) > 0 ? Number(expected.speech_end_sec) : null
  const speechEndSec = recordedSpeechEnd ?? (window ? window.start_sec : null)

  const plannedGaps = speechEndSec !== null && expected.section_gaps
    ? sectionGapWindows(expected.section_gaps, speechEndSec)
    : []

  for (const run of actual.silence) {
    const length = run.end_sec - run.start_sec
    if (length < o.silence_min_sec) continue
    if (speechEndSec === null) {
      // Nothing recorded where this file's speech stops — a render from before the plan sidecar
      // existed (Night Atlas Science EP0006, 2026-10-19), whose every expected value is 0. "Inside
      // the speech" is a claim the check cannot support here, so it does not make it. A silence that
      // runs to the file's own end is how an ordinary ending looks and is never a fault; anything
      // else is reported as the plain fact it is, for a person to look at.
      //
      // "An ordinary ending" is bounded by the length check above: the exemption here is only ever a
      // closing tail's worth of silence, because `unplannedDurationIssue` reports anything past
      // `MAX_CLOSING_TAIL_SEC` as the file being the wrong length. A 100-minute silent tail is not a
      // gap in the speech and is not called one — it is the length the video should not have.
      if (run.end_sec >= actual.duration_sec - SPEECH_END_MARGIN_SEC) continue
      issues.push({
        check: 'silence',
        verdict: `there is a ${length.toFixed(1)}s silence at ${clock(run.start_sec)}, and this video's `
          + 'speech end is not recorded, so the check cannot say whether it is a gap in the speech '
          + 'or the video ending',
      })
      continue
    }
    if (run.start_sec >= speechEndSec - 0.5) continue
    // A pause the merge put between sections on purpose: the silence lies within it, give or take.
    if (plannedGaps.some(w => run.start_sec >= w.start_sec - SECTION_GAP_TOLERANCE_SEC
      && run.end_sec <= w.end_sec + SECTION_GAP_TOLERANCE_SEC)) continue
    issues.push({
      check: 'silence',
      verdict: `there is a ${length.toFixed(1)}s silence at ${clock(run.start_sec)}, inside the speech`,
    })
  }

  if (actual.video_sec !== null && actual.audio_sec !== null) {
    const delta = actual.video_sec - actual.audio_sec
    if (Math.abs(delta) > o.av_tolerance_sec) {
      issues.push({
        check: 'av',
        verdict: `its picture is ${actual.video_sec.toFixed(1)}s and its sound ${actual.audio_sec.toFixed(1)}s, `
          + `which differ by ${Math.abs(delta).toFixed(1)}s`,
      })
    }
  }

  if (expected.subtitles_path) {
    let size = 0
    try { size = statSync(expected.subtitles_path).size } catch { size = 0 }
    if (size === 0) {
      issues.push({
        check: 'subtitles',
        verdict: `this episode asks for captions, but ${expected.subtitles_path} is missing or empty`,
      })
    }
  }

  if (expected.width > 0 && expected.height > 0
    && (actual.width !== expected.width || actual.height !== expected.height)) {
    issues.push({
      check: 'resolution',
      verdict: `it is ${actual.width}x${actual.height} but Video Assembly was set to ${expected.width}x${expected.height}`,
    })
  }

  return issues
}

/**
 * The black an intro asset itself carries, measured once per asset per process.
 *
 * A branded intro is one small file behind every episode on the channel, so it is measured at most
 * once and re-used: the cache is keyed by the file's own path, size and mtime, so a re-made intro is
 * measured again and the answer is never about bytes that are gone (AGENTS.md §6).
 *
 * An asset this machine cannot read carries no measured black, so nothing is exempted on its word:
 * the check reports the stretch, as it did before this rule existed.
 */
const introBlackCache = new Map<string, {
  size: number
  mtime_ms: number
  runs: Array<{ start_sec: number; end_sec: number }>
}>()

async function measureIntroAssetBlack(
  assetPath: string,
  o: Required<FinalCheckOptions>,
): Promise<Array<{ start_sec: number; end_sec: number }>> {
  let size = 0
  let mtime_ms = 0
  try {
    const stat = statSync(assetPath)
    size = stat.size
    mtime_ms = stat.mtimeMs
  } catch {
    return []
  }
  const cached = introBlackCache.get(assetPath)
  if (cached && cached.size === size && cached.mtime_ms === mtime_ms) return cached.runs
  try {
    const stderr = await runFfmpeg([
      '-hide_banner', '-nostdin', '-i', assetPath,
      '-vf', `blackdetect=d=${o.black_min_sec}:pix_th=${o.black_pixel_threshold}`,
      '-f', 'null', '-',
    ], { timeoutMs: o.timeout_ms })
    const runs = parseBlackdetect(stderr)
    introBlackCache.set(assetPath, { size, mtime_ms, runs })
    return runs
  } catch {
    return []
  }
}

/**
 * Measure the finished file and decide. Two ffmpeg passes at most: one that decodes picture and
 * sound together for the black and silence runs, and — only when the episode asks for closing
 * music — a short audio-only pass over the tail.
 */
export async function runFinalCheck(
  videoPath: string,
  expected: FinalCheckExpectation,
  overrides: FinalCheckOptions = {},
): Promise<FinalCheckResult> {
  const o = opts(overrides)
  const info = await getMediaInfo(videoPath)

  const analysis = await runFfmpeg([
    '-hide_banner', '-nostdin', '-i', videoPath,
    '-vf', `blackdetect=d=${o.black_min_sec}:pix_th=${o.black_pixel_threshold}`,
    // A final with no sound track at all is a verdict the upload's own `valid_video` check owns;
    // passing `-af` here would only turn it into a thrown ffmpeg error instead.
    ...(info.hasAudio ? ['-af', `silencedetect=n=${o.silence_noise_db}dB:d=${o.silence_min_sec}`] : []),
    '-f', 'null', '-',
  ], { timeoutMs: o.timeout_ms })

  const window = tailWindow(info.durationSec, expected.tail)
  let tailLufs: number | null = null
  if (window && expected.closing_music) {
    const tailStderr = await runFfmpeg([
      '-hide_banner', '-nostdin',
      '-ss', window.start_sec.toFixed(3), '-t', (window.end_sec - window.start_sec).toFixed(3),
      '-i', videoPath, '-vn', '-af', EBUR128_FILTER, '-f', 'null', '-',
    ], { timeoutMs: o.timeout_ms })
    tailLufs = parseEbur128Summary(tailStderr).lufs
  }

  const actual: FinalCheckResult['actual'] = {
    duration_sec: info.durationSec,
    video_sec: info.videoDurationSec ?? null,
    audio_sec: info.audioDurationSec ?? null,
    width: info.width ?? 0,
    height: info.height ?? 0,
    tail_lufs: tailLufs,
    black: parseBlackdetect(analysis),
    silence: parseSilencedetect(analysis, info.durationSec),
  }
  // The intro's own black is the owner's content, and measuring it is a third ffmpeg pass over a
  // small asset — skipped entirely when the caller already carries a measurement, so re-reading a
  // stored verdict costs nothing.
  const resolved: FinalCheckExpectation = expected.intro && !Array.isArray(expected.intro.black)
    ? { ...expected, intro: { ...expected.intro, black: await measureIntroAssetBlack(expected.intro.asset, o) } }
    : expected
  const issues = finalCheckIssues(actual, resolved, overrides)
  return {
    checked_at: new Date().toISOString(),
    file: identityOf(videoPath),
    expected: resolved,
    actual,
    passed: issues.length === 0,
    issues,
  }
}

/** The file's identity right now. Never throws — an unreadable file is a size/mtime of 0. */
function identityOf(videoPath: string): FinalCheckFileIdentity {
  try {
    const s = statSync(videoPath)
    return { size: s.size, mtime_ms: s.mtimeMs }
  } catch {
    return { size: 0, mtime_ms: 0 }
  }
}

/** Write the verdict beside the final. */
export async function storeFinalCheck(videoPath: string, result: FinalCheckResult): Promise<void> {
  await fs.writeFile(finalCheckPath(videoPath), `${JSON.stringify(result, null, 2)}\n`)
}

/**
 * The check as something that outlives the request that asked for it.
 *
 * Measuring a finished 2–2.5 h final is one full decode (5–8 minutes here) plus, when the episode
 * asks for music over its closing tail, a short audio-only pass — far longer than a request may
 * reasonably stay open, and the request was the only thing keeping it alive: the on-demand POST ran
 * it inline, so any restart, app update or dropped socket in between threw the whole measurement
 * away. Night Atlas Mythology EP0008, 2026-10-19: the app quit to install 1.4.331 eight minutes and
 * twenty-three seconds into the check and no verdict was stored, while the check had been running
 * the whole time.
 *
 * So the caller starts the check and answers; the check finishes on its own and writes the same
 * sidecar it always wrote. One per file at a time — a second request for a file already being
 * measured joins the run in progress rather than starting a second decode of the same bytes.
 *
 * The entry outlives the run so a run that produced no verdict can say so, instead of the row
 * reading "not run yet", which would mean both "nobody asked" and "it was asked and failed"
 * (AGENTS.md §6). One small entry per file measured in this process, and — for the run a process
 * boundary cut short — the durable marker `startFinalCheck` leaves behind.
 */
export interface FinalCheckProgress {
  /** True while a check is measuring this file right now. */
  running: boolean
  /** Why the last run on this file stored no verdict, or null. */
  error: string | null
  /**
   * A check on this file was started and never wrote a verdict: this process died in the middle of
   * one (or is still measuring it, which `running` already says). False for a file nobody asked
   * about, and false once a verdict exists.
   */
  interrupted: boolean
}

const finalCheckRuns = new Map<string, FinalCheckProgress>()

/**
 * What is known about this file: what this process is doing (or last did) about it, and — when it
 * knows nothing — whether a previous process left a check unfinished. The marker is only consulted
 * for a file this process has no record of, so the steady state costs one `statSync` per file per
 * listing row and the ordinary answers never change.
 */
export function finalCheckProgress(videoPath: string): FinalCheckProgress {
  const known = finalCheckRuns.get(videoPath)
  if (known) return known
  return { running: false, error: null, interrupted: existsSync(finalCheckRunMarkerPath(videoPath)) }
}

/**
 * How many files are being measured right now.
 *
 * A check is local ffmpeg work that a restart kills mid-decode and that cannot pick up where it
 * stopped, so an install waits for it exactly as it waits for a running job that would not resume
 * (`services/app-update.ts`'s drain, wired in `routes/app-update.ts`).
 */
export function runningFinalChecks(): number {
  let running = 0
  for (const entry of finalCheckRuns.values()) if (entry.running) running += 1
  return running
}

/** The measurement itself. Indirected only so a test can run a check without spawning ffmpeg. */
let measure: typeof runFinalCheck = runFinalCheck

/** Test seam: swap the measurement, or `null` to restore the real one. */
export function __setFinalCheckRunnerForTests(runner: typeof runFinalCheck | null): void {
  measure = runner ?? runFinalCheck
}

/**
 * Start measuring this file, or join the run already measuring it. Returns at once — the caller
 * must NOT await the check; its verdict lands in the sidecar when it finishes.
 *
 * The marker is written SYNCHRONOUSLY before the decode begins: it is the only record that survives
 * a process that never comes back, and it must exist before any work does. One write, once, in front
 * of a measurement that takes minutes.
 */
export function startFinalCheck(
  videoPath: string,
  expected: FinalCheckExpectation,
  overrides: FinalCheckOptions = {},
): { started: boolean } {
  if (finalCheckRuns.get(videoPath)?.running) return { started: false }
  const entry: FinalCheckProgress = { running: true, error: null, interrupted: false }
  finalCheckRuns.set(videoPath, entry)
  try { writeFileSync(finalCheckRunMarkerPath(videoPath), `${new Date().toISOString()}\n`) } catch { /* the run still matters more than its record */ }
  void measure(videoPath, expected, overrides)
    .then(result => storeFinalCheck(videoPath, result))
    .catch((error: unknown) => {
      entry.error = (error as Error)?.message || String(error)
      // Loud on purpose: nothing is waiting on this run, so this line is the only place it surfaces.
      logLine('error', `Final check could not run on ${videoPath}: ${entry.error}`)
    })
    .finally(() => {
      entry.running = false
      // A verdict, or the reason there is none, is on disk now: the marker has said its piece.
      try { rmSync(finalCheckRunMarkerPath(videoPath), { force: true }) } catch { /* best effort */ }
    })
  return { started: true }
}

export interface StoredFinalCheck {
  result: FinalCheckResult
  /** True when the file has been rewritten since the check ran (size or mtime moved). */
  stale: boolean
}

/**
 * Which verdict an upload is being decided against, and which file it was measured on.
 *
 * `checked_at` is the whole key: it names the stored verdict, and that verdict carries the file's
 * size and mtime as they were when it ran — so echoing `checked_at` back binds an answer to one
 * exact check of one exact file, without hashing 2–4 GB of video.
 */
export interface FinalCheckIdentity {
  /** When the check ran — the stored verdict's own `checked_at`. */
  checked_at: string
  /** The finished file's size when it was checked. */
  file_size: number
  /** The finished file's mtime (ms) when it was checked. */
  file_mtime_ms: number
}

/** That identity, or null when this file carries no verdict at all. */
export function finalCheckIdentity(stored: StoredFinalCheck | null): FinalCheckIdentity | null {
  if (!stored) return null
  return {
    checked_at: stored.result.checked_at,
    file_size: stored.result.file.size,
    file_mtime_ms: stored.result.file.mtime_ms,
  }
}

/**
 * True when `checkedAt` names the verdict that still describes this file — the check the owner
 * reviewed is the one on disk, and the file has not moved since it ran.
 *
 * A rewritten file fails (the stored verdict no longer describes those bytes), and so does a verdict
 * that has been replaced by a newer one: an answer about one check is not an answer about the next.
 */
export function finalCheckIdentityMatches(stored: StoredFinalCheck | null, checkedAt: string): boolean {
  return !!stored && !stored.stale && stored.result.checked_at === checkedAt
}

/**
 * The verdict stored beside this file, or null when there is none. A sidecar that cannot be read is
 * null, not a guess — "not checked" and "checked and fine" are different answers.
 */
export async function readStoredFinalCheck(videoPath: string): Promise<StoredFinalCheck | null> {
  let result: FinalCheckResult
  try {
    result = JSON.parse(await fs.readFile(finalCheckPath(videoPath), 'utf-8'))
  } catch {
    return null
  }
  if (!result || typeof result !== 'object' || !Array.isArray(result.issues)) return null
  // The shape must also agree with itself before it is trusted: `passed` is a boolean that matches
  // `issues`, and every issue carries a verdict. A sidecar that disagrees with itself is corrupt or
  // foreign — `storeFinalCheck` writes `runFinalCheck`'s own result, and that sets
  // `passed: issues.length === 0` — so it is answered as "not checked" and the check reruns. Never a
  // pass (the callers short-circuit on `passed`), and never a throw: one bad file must not take the
  // whole publishable listing down with it.
  if (typeof result.passed !== 'boolean' || result.passed !== (result.issues.length === 0)) return null
  if (!result.issues.every((issue) => !!issue && typeof issue.verdict === 'string')) return null
  // Async: this runs once per episode on the publishable listing, and a synchronous stat per row is
  // the shape services/utils.ts warns about.
  const stat = await fs.stat(videoPath).catch(() => null)
  const now = stat ? { size: stat.size, mtime_ms: stat.mtimeMs } : { size: 0, mtime_ms: 0 }
  const stale = !result.file || result.file.size !== now.size || result.file.mtime_ms !== now.mtime_ms
  return { result, stale }
}

/**
 * Why this final may not be uploaded, or null when it may.
 *
 * A final that was never checked is NOT refused: Video Assembly writes a verdict for every render it
 * makes, so a missing one means a file from before this check existed or a check that could not run —
 * and refusing there would block real work over an absence rather than over a fault. The row still
 * says "not run yet", and Upload Center can run it on demand.
 */
export function finalCheckVerdict(stored: StoredFinalCheck | null): string | null {
  if (!stored) return null
  if (stored.stale) return 'changed since its final check, so that verdict no longer describes it'
  if (stored.result.passed) return null
  const [first, ...rest] = stored.result.issues
  return rest.length === 0
    ? first!.verdict
    : `${first!.verdict} (and ${rest.length} more problem${rest.length === 1 ? '' : 's'})`
}

/**
 * The row's one line: "Final check: passed", or the first thing that is wrong with it.
 *
 * A check running in the background says so, a run that ended without a verdict says that too, and
 * so does a run a process boundary cut short — otherwise the row would read "not run yet", which is
 * the answer for a file nobody has asked about. A stored verdict outranks a failed re-run: it still
 * describes these bytes.
 */
export function finalCheckSummary(
  stored: StoredFinalCheck | null,
  progress: FinalCheckProgress = { running: false, error: null, interrupted: false },
): string {
  if (progress.running) return 'Final check: checking…'
  if (!stored) {
    if (progress.error) return `Final check: could not run — ${progress.error}`
    // A check that was started and never came back is not a file nobody asked about: the app quit
    // or crashed mid-decode, so this file is unchecked because the run was cut short, not because
    // nobody wanted it checked. Saying so is what lets the owner press the button again on purpose.
    if (progress.interrupted) return 'Final check: did not finish — the app restarted before it wrote a verdict. Run it again.'
    return 'Final check: not run yet'
  }
  if (stored.stale) return 'Final check: out of date — the video changed since it was checked'
  if (stored.result.passed) return 'Final check: passed'
  return `Final check: ${stored.result.issues.length} problem${stored.result.issues.length === 1 ? '' : 's'} — ${stored.result.issues[0]!.verdict}`
}
