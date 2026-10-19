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
import { statSync } from 'fs'
import { getMediaInfo } from './ffmpeg-validation.js'
import { finalDurationIssue } from './video-enabled-inputs.js'
import { EBUR128_FILTER, parseEbur128Summary } from '../generators/music-episode-build.js'
import { runFfmpeg } from './ffmpeg-utils.js'

/** Where the verdict lives: beside the final, so it travels with the file it describes. */
export function finalCheckPath(videoPath: string): string {
  return `${videoPath}.finalcheck.json`
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

  const duration = finalDurationIssue(actual.duration_sec, expected.planned_sec)
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
    issues.push({
      check: 'black',
      verdict: `there is a ${length.toFixed(1)}s black stretch at ${clock(run.start_sec)}, outside the closing tail`,
    })
  }

  // Where the speech stops in this file, or null when nothing recorded it. A closing tail starts
  // exactly where the speech stops, so a tail that is known IS a known speech end.
  const speechEndSec = window
    ? window.start_sec
    : (Number(expected.speech_end_sec) > 0 ? Number(expected.speech_end_sec) : null)

  for (const run of actual.silence) {
    const length = run.end_sec - run.start_sec
    if (length < o.silence_min_sec) continue
    if (speechEndSec === null) {
      // Nothing recorded where this file's speech stops — a render from before the plan sidecar
      // existed (Night Atlas Science EP0006, 2026-10-19), whose every expected value is 0. "Inside
      // the speech" is a claim the check cannot support here, so it does not make it. A silence that
      // runs to the file's own end is how an ordinary ending looks and is never a fault; anything
      // else is reported as the plain fact it is, for a person to look at.
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
  const issues = finalCheckIssues(actual, expected, overrides)
  return {
    checked_at: new Date().toISOString(),
    file: identityOf(videoPath),
    expected,
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

/** The row's one line: "Final check: passed", or the first thing that is wrong with it. */
export function finalCheckSummary(stored: StoredFinalCheck | null): string {
  if (!stored) return 'Final check: not run yet'
  if (stored.stale) return 'Final check: out of date — the video changed since it was checked'
  if (stored.result.passed) return 'Final check: passed'
  return `Final check: ${stored.result.issues.length} problem${stored.result.issues.length === 1 ? '' : 's'} — ${stored.result.issues[0]!.verdict}`
}
