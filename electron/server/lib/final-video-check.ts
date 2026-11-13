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
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import { existsSync, rmSync, statSync, writeFileSync } from 'fs'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
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

/**
 * Where a plan-less final's FROZEN expectation lives: beside the final, like its verdict, so it
 * travels with the file it describes and a person can read it without the app.
 *
 * Separate from `finalCheckPath` because a final that has never been checked still needs one: the
 * whole point is to write it down BEFORE the channel's settings change under it (owner decision,
 * 2026-10-20 — see `FrozenFinalCheckShape`).
 *
 * The suffix does not end in `.finalcheck.json`, so nothing that claims every final-check sidecar by
 * its ending claims this (AGENTS.md §6).
 */
export function frozenExpectationPath(videoPath: string): string {
  return `${videoPath}.finalcheck.expectation.json`
}

/**
 * What a plan-less final was made to be, written down once and never re-derived.
 *
 * A final from before the 1.4.327 sidecar records no plan of its own, so its expected length and its
 * intro have to come from somewhere else — and "the channel's Video Assembly settings" is a moving
 * target. Owner decision, 2026-10-20: existing Sprout finals keep their long silent still tail and
 * their branded intro, while FUTURE episodes drop that 6000 s `after_scenes` clip. Once the clip is
 * dropped, reading today's settings would measure SS0063's 9354 s final against a ~15 s tail and
 * STOP a file the owner said to keep.
 *
 * So the shape is frozen onto the file: taken once from the settings as they were, then read back
 * from this record for every later check. `file` is the bytes it describes — a rewritten final is not
 * this one, and a freeze that no longer describes these bytes says nothing (AGENTS.md §6).
 */
export interface FrozenFinalCheckShape {
  schema_version: 1
  /** When it was taken. */
  frozen_at: string
  /** The episode the final belongs to, for a person reading the file. */
  episode_code: string
  /** The bytes this freeze is about. */
  file: FinalCheckFileIdentity
  /**
   * Where the shape came from: the render's own recorded plan, its own saved request, the channel's
   * settings, or the owner's own recorded decision that a finished video's expectation be taken from
   * today's settings.
   */
  source: 'plan' | 'job' | 'settings' | 'owner'
  /** See `FinalCheckExpectation.after_narration_sec`. */
  after_narration_sec: number
  /**
   * See `FinalCheckExpectation.tail`: the closing tail's length and how far its end sits from the
   * file's end. `null` = the freeze proves this final drew no tail; absent = a freeze written before
   * this field existed, whose tail placement is unknown, never 0.
   */
  tail?: { sec: number; from_end_sec: number } | null
  /** See `FinalCheckExpectation.intro`; `null` is an answer (this final drew no intro). */
  intro: FinalCheckIntro | null
  /**
   * A content fingerprint of ONLY the fields that shape the expectation — the intro slot (its clip,
   * its outro, its timeline clips) and the timeline slot's post-audio block — and of nothing else.
   *
   * The whole settings file's mtime cannot say whether the fields that shaped a final moved: any
   * save anywhere in the channel rewrites it, so it is newer than every final ever rendered and
   * proves nothing (2026-10-20). This is the narrow answer to the same question, taken over the
   * fields that actually produce a shape: two settings objects with the same fingerprint ask for the
   * same tail and the same intro, whatever else moved in the file. `source` and `evidence` say where
   * the shape was taken from; this says exactly which settings it was taken from, so a reader can
   * compare it with the fields in force now.
   */
  shaping_fingerprint?: string
  /** The evidence the freeze was taken from, in words, for a person reading the record. */
  evidence?: string
  /** Present only on a `source: 'owner'` freeze: the decision it was taken on, in the owner's words. */
  owner?: OwnerFreezeDecision
}

/**
 * The owner's decision a `source: 'owner'` freeze was taken on, recorded with the freeze itself.
 *
 * A freeze taken from today's settings is taken on someone's authority, and the record has to say
 * whose and on what words — otherwise it is indistinguishable from an inference the app made. The
 * quotes are verbatim, and `turn_id` names the turn they came from.
 */
export interface OwnerFreezeDecision {
  /** When the owner gave the decision. Nothing rendered at or after this is in its scope. */
  decision_at: string
  /** The turn the two quotes came from. */
  turn_id: string
  /** What the owner approved, in the words they approved. */
  described_as: string
  /** The owner's approval, verbatim. */
  approve_quote: string
  /** The earlier decision this one builds on, verbatim. */
  retain_quote: string
}

/** A frozen shape, and whether the final has been rewritten since it was taken. */
export interface StoredFrozenShape {
  shape: FrozenFinalCheckShape
  stale: boolean
}

/**
 * The frozen expectation beside this final, or null when there is none. A record that cannot be read
 * is null, never a guess — "not frozen" and "frozen and fine" are different answers.
 */
export async function readFrozenShape(videoPath: string): Promise<StoredFrozenShape | null> {
  let shape: FrozenFinalCheckShape
  try {
    shape = JSON.parse(await fs.readFile(frozenExpectationPath(videoPath), 'utf-8'))
  } catch {
    return null
  }
  if (!shape || typeof shape !== 'object' || shape.schema_version !== 1) return null
  if (typeof shape.frozen_at !== 'string' || !shape.frozen_at) return null
  if (!Number.isFinite(Number(shape.after_narration_sec))) return null
  const stat = await fs.stat(videoPath).catch(() => null)
  const now = stat ? { size: stat.size, mtime_ms: stat.mtimeMs } : { size: 0, mtime_ms: 0 }
  return { shape, stale: !shape.file || shape.file.size !== now.size || shape.file.mtime_ms !== now.mtime_ms }
}

/**
 * Write this final's frozen expectation, or leave the one already there alone. Idempotent: a second
 * freeze of the same bytes writes nothing, so re-running it can never move an answer that a check
 * has already been decided against.
 *
 * A freeze that no longer describes these bytes is replaced — it was about a file that is gone, and
 * keeping it would be keeping an answer for the wrong video. That is the one case this writes over
 * an existing record, and it says so in the result.
 */
export async function freezeShape(
  videoPath: string,
  shape: FrozenFinalCheckShape,
): Promise<'written' | 'kept' | 'replaced'> {
  const existing = await readFrozenShape(videoPath)
  if (existing && !existing.stale) return 'kept'
  await fs.writeFile(frozenExpectationPath(videoPath), `${JSON.stringify(shape, null, 2)}\n`)
  return existing ? 'replaced' : 'written'
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
  /**
   * Where the closing MUSIC runs when that is not the held tail — the bed baked under an appended
   * outro. Its end sits `from_end_sec` before the file's end (0 = the true end). Absent = the music
   * runs over `tail`, as before.
   */
  closing_music_window?: { sec: number; from_end_sec: number }
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
  /**
   * The fitted text title card this render drew. Its black background is the episode's content, so
   * a black stretch inside `window` is excused — but only with a trusted proof AND a finished frame
   * that really shows non-blank text inside the safe margins (see `isTitleCardBlack`).
   */
  title_card?: FinalCheckTitleCard
  /**
   * The Sketch Draw scenes' expected blank starts, in the finished file's own clock. Each entry is
   * one scene whose own clip receipt says it drew from a bare canvas for a recorded number of
   * frames. A black stretch that begins at that scene's start and ends inside that window is the
   * canvas; black that starts mid-scene, elsewhere, or runs past the window is still judged.
   *
   * Absent means the episode is not a Sketch Draw episode, or the check could not establish the
   * scenes' actual timing — and then nothing is exempted (AGENTS.md §6).
   */
  scene_blank_starts?: FinalCheckSceneBlankStart[]
  /**
   * True only for a freeze taken before the shape recorded its tail geometry. The file's intended
   * closing-tail placement is then unknown, so a black stretch near the end cannot be called
   * "outside the closing tail": it is reported as a STOP whose placement could not be established.
   * A frozen `tail` (including 0 s) is a known answer, not an absence (AGENTS.md §6).
   */
  tail_unknown?: boolean
  /**
   * When this final's own expectation was frozen for the bytes it describes (`FrozenFinalCheckShape`),
   * or absent when it was not.
   *
   * Its PRESENCE — not any value beside it — is what says the expected length and the intro are
   * established for this file: a frozen 0 s tail and no intro are answers, not absences (AGENTS.md §6).
   */
  frozen_at?: string
  /**
   * Why this final's expected length and its own intro cannot be established, or absent when they
   * can. A plan-less final whose channel settings changed after it was rendered, with no freeze
   * taken in time, is exactly this: the check reports it rather than measuring the file against
   * settings that no longer describe it.
   */
  expectation_unknown?: string
}

/**
 * One Sketch Draw scene's expected blank start in the finished file.
 *
 * A Sketch Draw clip opens on the renderer's bare canvas and draws the picture over its reveal
 * window, so a short dark stretch at that scene's own start is the canvas arriving, not a hole the
 * render invented (owner-confirmed on MineePod EP0029, 2026-11-06: 45 such stretches were intended).
 * The window is bounded by the scene's ACTUAL timing and the reveal length its own clip receipt
 * records — never a guessed duration.
 */
export interface FinalCheckSceneBlankStart {
  /** The scene's id in the episode's plan, so a verdict can name it. */
  scene_id: string
  /** Where this scene starts in the finished file's own clock. */
  start_sec: number
  /** Where its reveal window ends. Black past this is not the blank canvas. */
  end_sec: number
  /** The reveal type the scene rendered with, when it is known. */
  reveal?: string
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

/**
 * A text title card the render drew, and the raster proof that its text is actually on screen.
 *
 * A card's black background is content the episode asked for, so a black stretch inside its window is
 * not a gap — but ONLY when the title is really drawn and inside the frame. The proof records what
 * was rendered; `runFinalCheck` also measures the finished file's own frame at the card's midpoint,
 * so a card that encoded blank or clipped is still reported as black.
 */
export interface FinalCheckTitleCard {
  /** Where the card plays in the finished file. */
  window: { start_sec: number; end_sec: number }
  /**
   * What the card renderer measured on the raster it actually overlaid: the text, its hash, the ink
   * bounds, the frame size and how many non-transparent pixels it drew. A proof whose text hash does
   * not describe its text is not trusted, and nothing is exempted.
   */
  proof: {
    text: string
    text_sha256: string
    rendered_sha256: string
    bounds: { left: number; top: number; right: number; bottom: number }
    frame: { width: number; height: number }
    safe_margin_px: number
    nonblank_pixels: number
    font_id: string
    font_px: number
    lines: number
  }
}

/** What the finished file itself shows at the title card's midpoint. */
export interface FinalCheckTitleCardFrame {
  measured_at_sec: number
  nonblank_pixels: number
  bounds: { left: number; top: number; right: number; bottom: number } | null
  frame: { width: number; height: number }
  /** Why the frame could not be measured; absent when it was. */
  error?: string
}

/** Each section's length in playback order, and the pause between neighbouring sections. */
export interface PlannedSectionGaps {
  gap_sec: number
  durations_sec: number[]
}

export interface FinalCheckIssue {
  /** The check's id, so a caller can name one problem without parsing the sentence. */
  check: 'duration' | 'closing_tail' | 'black' | 'silence' | 'av' | 'subtitles' | 'resolution' | 'unreadable' | 'expectation'
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
    /** The closing MUSIC's integrated loudness — the held tail, or the outro span when the bed was baked under it. Null when that window is digital silence. */
    tail_lufs: number | null
    black: Array<{ start_sec: number; end_sec: number }>
    silence: Array<{ start_sec: number; end_sec: number }>
    /** The finished file's own frame at the expected title card's midpoint, when one was expected. */
    title_card?: FinalCheckTitleCardFrame
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
  /** A silence LONGER than this inside the speech is a fault; up to and including it is fine (owner rule, 2026-11-03). Also the silencedetect `d` floor. */
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
  // Owner rule, 2026-11-03: a narration silence of up to and including 10 s is accepted; only
  // longer is flagged. A channel moves it in Settings → Safety checks (`config.final_check`).
  silence_min_sec: 10,
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

/** The seconds a channel's own silence threshold may sit between (the settings control's bounds too). */
export const SILENCE_MIN_SEC_BOUNDS = { min: 1, max: 300 } as const

/**
 * A channel's own final-check thresholds from its config, or `{}` when it keeps the defaults.
 *
 * Only a finite number inside the bounds becomes a threshold the check enforces: an absent,
 * out-of-range or hand-mangled value falls back to the default rather than silently becoming a
 * number nobody chose (AGENTS.md §6). The settings readback shows the threshold in force, so the
 * fallback is never invisible.
 */
export function finalCheckOptionsFromConfig(
  config: { final_check?: { silence_min_sec?: unknown } } | null | undefined,
): FinalCheckOptions {
  const raw = config?.final_check?.silence_min_sec
  return typeof raw === 'number' && Number.isFinite(raw)
    && raw >= SILENCE_MIN_SEC_BOUNDS.min && raw <= SILENCE_MIN_SEC_BOUNDS.max
    ? { silence_min_sec: raw }
    : {}
}

/** The same, read fresh from the channel at the moment a check starts — never cached. */
export async function finalCheckOptionsFor(slug: string | null | undefined): Promise<FinalCheckOptions> {
  if (!slug) return {}
  const { getConfig } = await import('../services/project-manager.js')
  return finalCheckOptionsFromConfig(await getConfig(slug))
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
export function unplannedDurationIssue(
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

/** How far a black stretch may start from a Sketch Draw scene's own boundary and still be its blank canvas (frame/transition rounding). */
const SCENE_BLANK_START_TOLERANCE_SEC = 1

/** How far past a scene's recorded reveal window a black stretch may run before the excess is a fault. */
const SCENE_BLANK_END_TOLERANCE_SEC = 0.5

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
export function isIntroAssetBlack(
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

/** How far a measured black stretch may sit from the title card's window and still be it (encode rounding). */
const TITLE_CARD_TOLERANCE_SEC = 0.5

/**
 * How far the FINISHED frame's ink may bleed past the proof's safe margin. yuv420p compression can
 * spread a glyph edge by a pixel or two; a genuinely clipped card starts at the frame edge, not two
 * pixels inside it.
 */
const TITLE_CARD_FRAME_BLEED_PX = 2

/** How far the finished frame's ink box may sit from the proof's box and still be the same card. */
const TITLE_CARD_BOUNDS_TOLERANCE_PX = 8

function withinSafeMargins(
  bounds: { left: number; top: number; right: number; bottom: number },
  frame: { width: number; height: number },
  margin: number,
): boolean {
  return frame.width > 0 && frame.height > 0
    && margin >= 0
    && bounds.left >= margin
    && bounds.top >= margin
    && bounds.right <= frame.width - margin
    && bounds.bottom <= frame.height - margin
    && bounds.right > bounds.left
    && bounds.bottom > bounds.top
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * True when this black stretch is the intentional title card, and the card really drew its text.
 *
 * Owner/developer decision, 2026-11-08 (Origin Field EP0031): the 5 s black after the intro was a
 * title card whose text was clipped off both ends. The exemption is therefore never "black in the
 * opening is fine". Four things must all hold:
 *
 *  1. the stretch lies inside the card's own window in the finished file;
 *  2. the expectation's proof is self-consistent — non-empty text whose SHA-256 is the stored hash,
 *     a recorded raster hash, real ink, and ink bounds inside the safe margins;
 *  3. the finished file itself was measured at the card's midpoint, and that frame is non-blank;
 *  4. the finished frame's ink bounds are inside the same safe margins at the same frame size.
 *
 * A card that encoded blank, clipped, or with no proof is reported as black, exactly like any other
 * unexplained stretch. A successful FFmpeg exit or a non-empty configured string is never proof.
 */
export function isTitleCardBlack(
  run: { start_sec: number; end_sec: number },
  titleCard: FinalCheckTitleCard | undefined,
  measured: FinalCheckTitleCardFrame | undefined,
): boolean {
  const window = titleCard?.window
  const proof = titleCard?.proof
  if (!window || !proof) return false
  if (!(window.end_sec > window.start_sec)) return false
  if (!proof.text.trim() || proof.text_sha256 !== sha256(proof.text)) return false
  if (!/^[0-9a-f]{64}$/.test(proof.rendered_sha256) || !(proof.nonblank_pixels > 0)) return false
  if (!Number.isFinite(proof.safe_margin_px) || proof.safe_margin_px < 0) return false
  if (!proof.bounds || !withinSafeMargins(proof.bounds, proof.frame, proof.safe_margin_px)) return false
  if (!measured || measured.error) return false
  const t = TITLE_CARD_TOLERANCE_SEC
  if (run.start_sec < window.start_sec - t || run.end_sec > window.end_sec + t) return false
  if (measured.measured_at_sec < window.start_sec || measured.measured_at_sec > window.end_sec) return false
  if (measured.frame.width !== proof.frame.width || measured.frame.height !== proof.frame.height) return false
  if (!(measured.nonblank_pixels > 0) || !measured.bounds) return false
  const measuredMargin = Math.max(0, proof.safe_margin_px - TITLE_CARD_FRAME_BLEED_PX)
  if (!withinSafeMargins(measured.bounds, measured.frame, measuredMargin)) return false
  // The finished frame must be the SAME card the proof describes, not merely some non-blank text in
  // the window. Re-encoding moves an edge by a pixel or two, never by a whole line.
  const near = (a: number, b: number) => Math.abs(a - b) <= TITLE_CARD_BOUNDS_TOLERANCE_PX
  return near(measured.bounds.left, proof.bounds.left)
    && near(measured.bounds.top, proof.bounds.top)
    && near(measured.bounds.right, proof.bounds.right)
    && near(measured.bounds.bottom, proof.bounds.bottom)
}

/** Pixels at or below this on every channel are the card's black background, not ink. */
const TITLE_CARD_INK_FLOOR = 48

/**
 * Extract the finished file's frame at the card's midpoint and measure its ink.
 *
 * Never throws: a frame that cannot be read is `error`, which `isTitleCardBlack` treats as untrusted.
 * One extra ffmpeg pass, only when the expectation carries a title card.
 */
export async function measureTitleCardFrame(
  videoPath: string,
  titleCard: FinalCheckTitleCard,
  overrides: FinalCheckOptions = {},
): Promise<FinalCheckTitleCardFrame> {
  const o = opts(overrides)
  const at = (titleCard.window.start_sec + titleCard.window.end_sec) / 2
  try {
    // The frame comes back over stdout as PNG bytes: no temp file to create, move or retire.
    const png = await captureFramePng(videoPath, at, o.timeout_ms)
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let left = info.width
    let top = info.height
    let right = 0
    let bottom = 0
    let nonblank = 0
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const index = (y * info.width + x) * 4
        if (data[index]! <= TITLE_CARD_INK_FLOOR
          && data[index + 1]! <= TITLE_CARD_INK_FLOOR
          && data[index + 2]! <= TITLE_CARD_INK_FLOOR) continue
        nonblank += 1
        if (x < left) left = x
        if (y < top) top = y
        if (x + 1 > right) right = x + 1
        if (y + 1 > bottom) bottom = y + 1
      }
    }
    return {
      measured_at_sec: at,
      nonblank_pixels: nonblank,
      bounds: nonblank > 0 ? { left, top, right, bottom } : null,
      frame: { width: info.width, height: info.height },
    }
  } catch (error: any) {
    return {
      measured_at_sec: at,
      nonblank_pixels: 0,
      bounds: null,
      frame: { width: 0, height: 0 },
      error: error?.message || String(error),
    }
  }
}

/** One PNG frame at `at` seconds, decoded from ffmpeg's stdout (image2pipe). */
async function captureFramePng(videoPath: string, at: number, timeoutMs: number): Promise<Buffer> {
  const ffmpegBin = await getFFmpegPath()
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (error: Error | null, png?: Buffer) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve(png!)
    }
    const proc = spawn(ffmpegBin, [
      '-hide_banner', '-nostdin', '-ss', at.toFixed(3), '-i', videoPath,
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        // Normal bounded termination: let ffmpeg exit on its own signal, never SIGKILL.
        proc.kill('SIGTERM')
        finish(new Error(`FFmpeg timed out after ${timeoutMs}ms measuring the title card frame`))
      }, timeoutMs)
    }
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096) })
    proc.on('error', error => finish(error))
    proc.on('close', code => {
      if (code === 0) finish(null, Buffer.concat(chunks))
      else finish(new Error(`FFmpeg exited with code ${code} measuring the title card frame: ${stderr}`))
    })
  })
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

  // A final whose own expectation cannot be established. The length and the intro are precisely what
  // is unknown, so neither is judged — measuring the file against settings that no longer describe it
  // would be inventing the very answer the check exists to give. Everything that does NOT depend on
  // the shape is still reported, and the verdict does not pass: "unknown" is not "fine" (AGENTS.md §6).
  const unknown = (expected.expectation_unknown || '').trim()
  if (unknown) {
    issues.push({
      check: 'expectation',
      verdict: `this video cannot be checked against what it was made for — ${unknown}. `
        + 'Its length and its own intro are not judged; everything else here is.',
    })
  }

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
  const duration = unknown
    ? null
    : plannedSec !== null
      ? finalDurationIssue(actual.duration_sec, plannedSec)
      : unplannedDurationIssue(actual.duration_sec, episodeSec, endingSilenceSec(actual))
  if (duration) issues.push({ check: 'duration', verdict: `the finished video ${duration}` })

  // The music may run under an appended outro, past the held tail. Measure THAT window when the
  // render recorded one, so "music reaches the true end" is what the verdict actually tests.
  const musicWindow = expected.closing_music_window
    ? tailWindow(actual.duration_sec, expected.closing_music_window)
    : window
  if (musicWindow && expected.closing_music) {
    if (actual.tail_lufs === null || actual.tail_lufs <= o.tail_silent_lufs) {
      const label = expected.closing_music_window ? 'closing music' : 'closing tail'
      issues.push({
        check: 'closing_tail',
        verdict: `the ${label} (${clock(musicWindow.start_sec)} to ${clock(musicWindow.end_sec)}) is silent, `
          + `but this episode asks for closing music over it`,
      })
    }
  }

  for (const run of actual.black) {
    const length = run.end_sec - run.start_sec
    if (length < o.black_min_sec) continue
    // A stretch inside the branded intro, which the intro's own asset is black over, is the owner's
    // opening. Only that: black anywhere else is still judged by the rules below.
    if (isIntroAssetBlack(run, expected.intro)) continue
    // A text title card's black background is the episode's content, but only when the finished
    // frame itself proves the title was drawn and stayed inside the safe margins.
    if (isTitleCardBlack(run, expected.title_card, actual.title_card)) continue
    // A legacy freeze recorded the tail's length but not where it sits. Calling this black "outside
    // the closing tail" would assert a placement the check does not know; report the fact as STOP.
    if (expected.tail_unknown) {
      issues.push({
        check: 'black',
        verdict: `there is a ${length.toFixed(1)}s black stretch at ${clock(run.start_sec)}; this video's `
          + 'intended closing-tail placement could not be established, so the check cannot say whether '
          + 'that black is the closing tail',
      })
      continue
    }
    // A black stretch inside the closing tail is the closing tail — that is what it was drawn for.
    if (run.start_sec >= bodyEnd - 0.5) continue
    // A Sketch Draw scene opens on its bare canvas, so a dark stretch that begins at that scene's
    // own start and ends inside its recorded reveal window is the canvas, not a fault. Only that:
    // a stretch starting mid-scene, or running past the window, is still reported.
    const blankStart = expected.scene_blank_starts?.find(scene =>
      run.start_sec >= scene.start_sec - SCENE_BLANK_START_TOLERANCE_SEC
      && run.start_sec <= scene.start_sec + SCENE_BLANK_START_TOLERANCE_SEC)
    if (blankStart) {
      if (run.end_sec <= blankStart.end_sec + SCENE_BLANK_END_TOLERANCE_SEC) continue
      issues.push({
        check: 'black',
        verdict: `there is a ${length.toFixed(1)}s black stretch at ${clock(run.start_sec)} that runs past the `
          + `${(blankStart.end_sec - blankStart.start_sec).toFixed(1)}s clean Sketch Draw reveal at `
          + `${blankStart.scene_id}'s start (ending ${clock(blankStart.end_sec)}), so the rest of it is unexpected`,
      })
      continue
    }
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
    // `<=` because the owner's rule accepts a silence OF the threshold (10 s is fine) and flags
    // only one longer than it; silencedetect's own `d` is the same number, so the boundary run is
    // still measured and then judged here.
    if (length <= o.silence_min_sec) continue
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
 *
 * Exported (2026-10-20) because the freeze takes the same measurement once, for the file it is about,
 * rather than letting a later check re-measure an asset that may have been replaced since.
 */
const introBlackCache = new Map<string, {
  size: number
  mtime_ms: number
  runs: Array<{ start_sec: number; end_sec: number }>
}>()

export async function measureIntroAssetBlack(
  assetPath: string,
  overrides: FinalCheckOptions = {},
): Promise<Array<{ start_sec: number; end_sec: number }>> {
  const o = opts(overrides)
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
 * The black in a final's OPENING, measured over the first `endSec` seconds only.
 *
 * The owner-approved freeze below is confirmed against the file itself, and one half of that
 * confirmation is "the black the opening shows is the black the intro asset carries". Measuring the
 * whole 2.5 h file for it would cost a full decode at boot; the opening is the only place it can be,
 * so `-t` before `-i` stops the read there.
 *
 * Never throws: an unreadable file measures as no black, and the caller decides what that means.
 */
export async function measureOpeningBlack(
  videoPath: string,
  endSec: number,
  overrides: FinalCheckOptions = {},
): Promise<Array<{ start_sec: number; end_sec: number }>> {
  const limit = Number(endSec)
  if (!(limit > 0)) return []
  const o = opts(overrides)
  try {
    const stderr = await runFfmpeg([
      '-hide_banner', '-nostdin', '-t', limit.toFixed(3), '-i', videoPath,
      '-vf', `blackdetect=d=${o.black_min_sec}:pix_th=${o.black_pixel_threshold}`,
      '-f', 'null', '-',
    ], { timeoutMs: o.timeout_ms })
    return parseBlackdetect(stderr)
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
  const musicWindow = expected.closing_music_window
    ? tailWindow(info.durationSec, expected.closing_music_window)
    : window
  let tailLufs: number | null = null
  if (musicWindow && expected.closing_music) {
    const tailStderr = await runFfmpeg([
      '-hide_banner', '-nostdin',
      '-ss', musicWindow.start_sec.toFixed(3), '-t', (musicWindow.end_sec - musicWindow.start_sec).toFixed(3),
      '-i', videoPath, '-vn', '-af', EBUR128_FILTER, '-f', 'null', '-',
    ], { timeoutMs: o.timeout_ms })
    tailLufs = parseEbur128Summary(tailStderr).lufs
  }

  // The card's own black may be excused, but only if the finished file really shows its text. One
  // extra frame decode at the card's midpoint — never a whole-file pass.
  const titleCardFrame = expected.title_card
    ? await measureTitleCardFrame(videoPath, expected.title_card, overrides)
    : undefined

  const actual: FinalCheckResult['actual'] = {
    duration_sec: info.durationSec,
    video_sec: info.videoDurationSec ?? null,
    audio_sec: info.audioDurationSec ?? null,
    width: info.width ?? 0,
    height: info.height ?? 0,
    tail_lufs: tailLufs,
    black: parseBlackdetect(analysis),
    silence: parseSilencedetect(analysis, info.durationSec),
    ...(titleCardFrame ? { title_card: titleCardFrame } : {}),
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
 * A check is local ffmpeg work that a restart kills mid-decode and cannot resume.
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
  onStored?: () => Promise<void>,
): { started: boolean } {
  if (finalCheckRuns.get(videoPath)?.running) return { started: false }
  const entry: FinalCheckProgress = { running: true, error: null, interrupted: false }
  finalCheckRuns.set(videoPath, entry)
  try { writeFileSync(finalCheckRunMarkerPath(videoPath), `${new Date().toISOString()}\n`) } catch { /* the run still matters more than its record */ }
  void measure(videoPath, expected, overrides)
    .then(async result => {
      await storeFinalCheck(videoPath, result)
      if (result.passed && onStored) {
        try { await onStored() } catch (error) {
          logLine('error', `Final check passed but automatic scheduling failed for ${videoPath}: ${(error as Error)?.message || error}`)
        }
      }
    })
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
 * The expectation a stored verdict recorded, when that verdict is about the file that is there NOW.
 *
 * A verdict the file has outlived describes bytes that are gone (`stale`), so everything it recorded
 * — its plan, the tail and intro it measured, the freeze it echoed — says nothing about the file on
 * disk. Reading it anyway is how one final's shape gets certified for another (2026-10-20): the
 * freeze sweep stamped a stale verdict's `after_narration_sec` and `intro` onto a rewritten file's
 * size and mtime, which made a record that no longer looks stale, and the on-demand check measured
 * the new bytes against the old plan and skipped the fresh resolution that could have answered.
 *
 * So a caller that means to ACT on a verdict takes it through here; the callers that mean to SHOW
 * one keep `readStoredFinalCheck`, which reports `stale` beside the verdict it still returns.
 */
export function freshStoredExpectation(stored: StoredFinalCheck | null): FinalCheckExpectation | undefined {
  return stored && !stored.stale ? stored.result.expected : undefined
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
