/**
 * The final check (2026-10-19) — the last thing that looks at a finished final video before it can be
 * uploaded.
 *
 * Both fixtures are the owner's own incidents from 2026-10-19, generated with ffmpeg into a temp
 * directory: a closing tail that rendered silent, and a picture that is not what the plan asked for.
 * Every gate was green in both.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  closingMusicWanted,
  FINAL_CHECK_DEFAULTS,
  finalCheckIdentity,
  finalCheckIdentityMatches,
  finalCheckIssues,
  finalCheckOptionsFromConfig,
  finalCheckPath,
  finalCheckSummary,
  finalCheckVerdict,
  freshStoredExpectation,
  isTitleCardBlack,
  parseBlackdetect,
  parseSilencedetect,
  plannedSecFromSectionGaps,
  plannedSectionGapsFromSidecar,
  readPlannedSectionGaps,
  readStoredFinalCheck,
  runFinalCheck,
  sectionGapWindows,
  SILENCE_MIN_SEC_BOUNDS,
  speechEndSecFromScenePlan,
  storeFinalCheck,
  tailWindow,
  type FinalCheckExpectation,
  type FinalCheckTitleCard,
} from '../lib/final-video-check.js'

let dir: string
before(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'final-video-check-')) })
after(() => { rmSync(dir, { recursive: true, force: true }) })

function ffmpeg(args: string[], name: string): string {
  const file = path.join(dir, name)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, file], { stdio: ['ignore', 'ignore', 'inherit'] })
  return file
}

const BLUE = 'color=c=blue:s=320x180:r=10:d=8'
const TONE = (seconds: number) => `sine=frequency=440:duration=${seconds}`

/** A finished render that is exactly what the plan asked for: 8 s, blue, one steady tone. */
let goodFile: string
/** The same length, black from 2 s to 5 s — a stretch the plan never asked for. */
let blackFile: string
/** Black only over the last 3 s: a `black-screen` closing tail, drawn on purpose. */
let blackTailFile: string
/** The same length, with the last 3 s silent — the music-closing incident. */
let silentTailFile: string
/** Picture 8 s, sound 5 s. */
let avMismatchFile: string

before(() => {
  goodFile = ffmpeg([
    '-f', 'lavfi', '-i', BLUE, '-f', 'lavfi', '-i', TONE(8),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ], 'good.mp4')

  blackFile = ffmpeg([
    '-f', 'lavfi', '-i', `${BLUE},drawbox=c=black:t=fill:enable='between(t,2,5)'`,
    '-f', 'lavfi', '-i', TONE(8),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ], 'black.mp4')

  blackTailFile = ffmpeg([
    '-f', 'lavfi', '-i', `${BLUE},drawbox=c=black:t=fill:enable='gte(t,5)'`,
    '-f', 'lavfi', '-i', TONE(8),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ], 'black-tail.mp4')

  silentTailFile = ffmpeg([
    '-f', 'lavfi', '-i', BLUE,
    '-f', 'lavfi', '-i', TONE(5),
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3',
    '-filter_complex', '[1][2]concat=n=2:v=0:a=1[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ], 'silent-tail.mp4')

  // No -shortest: the picture runs the full 8 s and the sound stops at 5.
  avMismatchFile = ffmpeg([
    '-f', 'lavfi', '-i', BLUE, '-f', 'lavfi', '-i', TONE(5),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  ], 'av-mismatch.mp4')
})

/** What the plan asked this render to be, unless a test says otherwise. */
function expect(over: Partial<FinalCheckExpectation> = {}): FinalCheckExpectation {
  return {
    planned_sec: 8,
    tail: { sec: 0, from_end_sec: 0 },
    closing_music: false,
    width: 320,
    height: 180,
    subtitles_path: null,
    ...over,
  }
}

describe('the finished file the plan asked for', () => {
  test('a correct render passes every check', async () => {
    const result = await runFinalCheck(goodFile, expect())
    assert.deepEqual(result.issues, [], JSON.stringify(result.actual))
    assert.equal(result.passed, true)
    assert.equal(result.actual.width, 320)
    assert.equal(result.actual.height, 180)
    assert.ok(Math.abs(result.actual.duration_sec - 8) < 0.5, `duration ${result.actual.duration_sec}`)
  })

  test('a tail that asks for no music is allowed to be silent', async () => {
    const result = await runFinalCheck(silentTailFile, expect({ tail: { sec: 3, from_end_sec: 0 } }))
    assert.deepEqual(result.issues, [], JSON.stringify(result.actual))
  })

  test('a video with no sound track still gets a verdict instead of an ffmpeg error', async () => {
    // The upload's own `valid_video` check owns "no sound"; this one must not turn it into a throw.
    const silent = ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    ], 'no-audio.mp4')
    const result = await runFinalCheck(silent, expect({ planned_sec: 3 }))
    assert.equal(result.passed, true, JSON.stringify(result.issues))
    assert.equal(result.actual.audio_sec, null)
  })
})

describe("the owner's incidents", () => {
  test('a closing tail that rendered silent fails, and says which seconds are silent', async () => {
    const result = await runFinalCheck(silentTailFile, expect({
      tail: { sec: 3, from_end_sec: 0 }, closing_music: true,
    }))
    assert.deepEqual(result.issues.map(issue => issue.check), ['closing_tail'])
    assert.match(result.issues[0]!.verdict, /closing tail \(0:05 to 0:08\) is silent/)
    assert.match(result.issues[0]!.verdict, /asks for closing music/)
  })

  test('an explicit closing music window names its own silent seconds', async () => {
    const result = await runFinalCheck(silentTailFile, expect({
      tail: { sec: 3, from_end_sec: 0 }, closing_music: true,
      closing_music_window: { sec: 2, from_end_sec: 0 },
    }))
    assert.deepEqual(result.issues.map(issue => issue.check), ['closing_tail'])
    assert.match(result.issues[0]!.verdict, /closing music \(0:06 to 0:08\) is silent/)
  })

  test('the same file passes the tail check once real music is over it', async () => {
    const result = await runFinalCheck(goodFile, expect({
      tail: { sec: 3, from_end_sec: 0 }, closing_music: true,
    }))
    assert.deepEqual(result.issues, [], JSON.stringify(result.actual))
    assert.ok(result.actual.tail_lufs !== null && result.actual.tail_lufs > -70, `tail ${result.actual.tail_lufs}`)
  })

  test('a black stretch outside the closing tail fails', async () => {
    const result = await runFinalCheck(blackFile, expect())
    assert.deepEqual(result.issues.map(issue => issue.check), ['black'])
    assert.match(result.issues[0]!.verdict, /black stretch at 0:02/)
  })

  test('the black stretch is not reported when it IS the closing tail', async () => {
    // A `black-screen` episode's closing tail is black on purpose.
    const result = await runFinalCheck(blackTailFile, expect({ tail: { sec: 3, from_end_sec: 0 } }))
    assert.deepEqual(result.issues.map(issue => issue.check), [])
    assert.ok(result.actual.black.length > 0, 'the fixture really does contain a black stretch')
  })

  test('a picture and sound that differ in length fail', async () => {
    const result = await runFinalCheck(avMismatchFile, expect())
    assert.deepEqual(result.issues.map(issue => issue.check), ['av'])
    assert.match(result.issues[0]!.verdict, /picture is 8\.0s and its sound 5\.0s/)
  })
})

/**
 * The branded intro's own black (owner, 2026-10-20: *"yes. it's my own settings."*).
 *
 * The exemption is never "black in an opening is fine": it is this episode's own intro ASSET being
 * black over that stretch, measured on the file itself. So the same finished video passes with the
 * channel's black intro behind it and stops with an intro that is not black there.
 */
describe('the black the branded intro asset itself carries', () => {
  const window = { start_sec: 0, end_sec: 8 }

  test('the intro asset is measured, and only its own black is exempt', async () => {
    // `blackFile` stands in as the channel's own intro: 8 s with black from 2 s to 5 s, the very
    // stretch the finished file carries — so it is the owner's own opening, not a fault.
    const own = await runFinalCheck(blackFile, expect({ intro: { asset: blackFile, window } }))
    assert.deepEqual(own.issues, [], JSON.stringify(own.actual))
    assert.ok((own.expected.intro?.black?.length ?? 0) > 0, 'the asset was measured, and stored with the verdict')

    // The same file, the same window, an intro asset that is NOT black there (`goodFile`): the
    // stretch is the render's own, and it stops exactly as it did before this rule existed.
    const other = await runFinalCheck(blackFile, expect({ intro: { asset: goodFile, window } }))
    assert.deepEqual(other.issues.map(issue => issue.check), ['black'])
    assert.match(other.issues[0]!.verdict, /black stretch at 0:02/)
    assert.deepEqual(other.expected.intro?.black, [], 'the other asset really does carry no black')
  })
})

describe('the verdicts that need no ffmpeg', () => {
  const actual = {
    duration_sec: 20, video_sec: 20, audio_sec: 20, width: 320, height: 180,
    tail_lufs: null, black: [], silence: [],
  }
  /** A plan this `actual` really is the answer to, so only the check under test can fail. */
  const plan = (over: Partial<FinalCheckExpectation> = {}) => expect({ planned_sec: 20, ...over })

  test('a length that misses the plan names both numbers and the difference', () => {
    const issues = finalCheckIssues(actual, plan({ planned_sec: 32.4 }))
    assert.deepEqual(issues.map(issue => issue.check), ['duration'])
    assert.match(issues[0]!.verdict, /20\.0s long but the narration, opening, outro and tail add up to 32\.4s \(-12\.4s\)/)
  })

  test('captions the episode asks for and does not have fail; no captions asked for does not', () => {
    const missing = path.join(dir, 'nowhere.srt')
    assert.deepEqual(
      finalCheckIssues(actual, plan({ subtitles_path: missing })).map(issue => issue.check),
      ['subtitles'],
    )
    assert.deepEqual(finalCheckIssues(actual, plan({ subtitles_path: null })), [])
  })

  test('a resolution that is not what Video Assembly was set to fails', () => {
    const issues = finalCheckIssues(actual, plan({ width: 1920, height: 1080 }))
    assert.deepEqual(issues.map(issue => issue.check), ['resolution'])
    assert.match(issues[0]!.verdict, /320x180 but Video Assembly was set to 1920x1080/)
  })

  test('a plan-less check still reports what it can measure, and claims nothing it cannot', () => {
    // The on-demand path for a file rendered before this feature existed: no plan to measure against.
    const issues = finalCheckIssues(
      { ...actual, black: [{ start_sec: 3, end_sec: 9 }] },
      plan({ planned_sec: 0, width: 0, height: 0 }),
    )
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
  })

  test('a silence short of the threshold is not reported, and one over it is', () => {
    const run = { start_sec: 4, end_sec: 7 }
    assert.deepEqual(finalCheckIssues({ ...actual, silence: [run] }, plan()), [])
    assert.deepEqual(
      finalCheckIssues({ ...actual, silence: [run] }, plan(), { silence_min_sec: 2 }).map(issue => issue.check),
      ['silence'],
    )
  })

  test("the owner's rule: a silence of exactly the threshold is fine, one past it is flagged", () => {
    // 2026-11-03: accept silence up to and including the threshold (10 s by default), flag only
    // longer — so the boundary run itself must be the accepted side of the line.
    assert.deepEqual(
      finalCheckIssues({ ...actual, silence: [{ start_sec: 4, end_sec: 14 }] }, plan()), [],
      'exactly 10 s is accepted by default',
    )
    assert.deepEqual(
      finalCheckIssues({ ...actual, silence: [{ start_sec: 4, end_sec: 14.1 }] }, plan()).map(issue => issue.check),
      ['silence'], '10.1 s is flagged by default',
    )
    // A channel's own threshold moves that line and behaves the same way on both sides of it.
    assert.deepEqual(
      finalCheckIssues({ ...actual, silence: [{ start_sec: 4, end_sec: 9 }] }, plan(), { silence_min_sec: 5 }), [],
    )
    assert.deepEqual(
      finalCheckIssues({ ...actual, silence: [{ start_sec: 4, end_sec: 9.1 }] }, plan(), { silence_min_sec: 5 })
        .map(issue => issue.check),
      ['silence'],
    )
  })

  test('a channel config sets the silence threshold; anything unusable keeps the default', () => {
    assert.deepEqual(finalCheckOptionsFromConfig(null), {})
    assert.deepEqual(finalCheckOptionsFromConfig({}), {})
    assert.deepEqual(finalCheckOptionsFromConfig({ final_check: { silence_min_sec: 30 } }), { silence_min_sec: 30 })
    // Out of range, the wrong type, or hand-mangled: the default applies — never a number nobody
    // chose, and never a silent zero standing for an answer (AGENTS.md §6).
    for (const bad of [0, -5, 301, NaN, Infinity, '20', null, true]) {
      assert.deepEqual(
        finalCheckOptionsFromConfig({ final_check: { silence_min_sec: bad } }), {},
        `silence_min_sec ${String(bad)} must not become a threshold`,
      )
    }
    assert.equal(FINAL_CHECK_DEFAULTS.silence_min_sec, 10, "the owner's default of 2026-11-03")
    assert.deepEqual(SILENCE_MIN_SEC_BOUNDS, { min: 1, max: 300 })
  })

  /**
   * Night Atlas Science EP0006, 2026-10-19: a 2:32:29 final rendered before the plan sidecar
   * existed, so every expected value is 0 and nothing anywhere records where the speech stops. The
   * check called its last 5.1 s "inside the speech" — a claim the file cannot support.
   */
  const legacy = {
    duration_sec: 9149, video_sec: 9149, audio_sec: 9148.98, width: 1920, height: 1080,
    tail_lufs: null, black: [], silence: [{ start_sec: 9143.93, end_sec: 9148.99 }],
  }
  /** The on-demand check of a file with no plan record: nothing to measure against. */
  const noPlan = () => expect({ planned_sec: 0, width: 0, height: 0 })

  test('a tail silence on a file with no recorded speech end is not a fault', () => {
    assert.deepEqual(finalCheckIssues(legacy, noPlan()), [])
    // Same for a longer one that runs to the file's own end: that is how an ending looks.
    assert.deepEqual(
      finalCheckIssues({ ...legacy, silence: [{ start_sec: 9140, end_sec: 9149 }] }, noPlan()),
      [],
    )
  })

  /**
   * The length the episode's own chapter plan adds up to — the one thing a final from before the plan
   * sidecar existed still carries. Story Sprout SS0063's own 16 sections and their 5 s pauses.
   */
  const chapters = {
    gap_sec: 5,
    durations_sec: [
      192.214785, 199.366531, 227.648435, 203.174603, 144.2, 121.68, 128.000042, 233.081905,
      286.53424, 237.586576, 185.945397, 201.549206, 198.205533, 232.617506, 229.506032, 233.267664,
    ],
  }
  /** What those chapters add up to: 3254.578455 s of narration + 15 pauses of 5 s. */
  const CHAPTERS_SEC = 3329.578455

  test('the chapters a plan-less final is measured against are the narration they add up to', () => {
    assert.equal(plannedSecFromSectionGaps(chapters), CHAPTERS_SEC)
    assert.equal(plannedSecFromSectionGaps(null), null, 'no plan, no number')
    assert.equal(plannedSecFromSectionGaps({ gap_sec: 0, durations_sec: [10, 10] }), null)
    assert.equal(plannedSecFromSectionGaps({ gap_sec: 5, durations_sec: [10] }), null, 'one section has no pause')
  })

  /**
   * Story Sprout SS0063, 2026-10-20. A final rendered before the plan sidecar existed (mtime
   * 2026-10-18), so the on-demand check reconstructed an all-zero expectation from it. The file is
   * 9354.2 s against 3329.6 s of chapters and ends in 6015.3 s of silence — and it passed both the
   * length and the tail silently, because `planned_sec` was 0 and a silence that runs to the file's
   * own end was exempt however long it was.
   *
   * The owner's decision the same day, verbatim: *"yes. it's my own settings. in fact, i want all
   * already made videos to retain this. but for newer ones from now on to no longer use the silence
   * thing but instead follows the rest of the sleep channels... so what's done is done."* The 100
   * minutes ARE the channel's own Video Assembly preset: `preset-1781671791580`, whose intro slot
   * carries `clip-1776875775168-cl5s` — a static still anchored `after_scenes` for 6000 s — plus a
   * 15 s `fade-to-black` post-roll. A final that is what its own settings asked for is not a fault.
   */
  const ss0063 = {
    duration_sec: 9354.208333, video_sec: 9354.208333, audio_sec: 9354.202993, width: 1920, height: 1080,
    tail_lufs: null,
    black: [{ start_sec: 4.75, end_sec: 9.208333 }],
    silence: [{ start_sec: 3338.882789, end_sec: 9354.20517 }],
  }
  /** SS0063's own settings: the 6000 s still plus the 15 s fade post-roll, and nothing else. */
  const SS0063_TAIL_SEC = 6015
  /** The same file, without the intro's own black — so a length test measures only the length. */
  const ss0063Length = { ...ss0063, black: [] as Array<{ start_sec: number; end_sec: number }> }

  test('a plan-less final far longer than its own chapters and its own clips is a length fault', () => {
    const issues = finalCheckIssues(ss0063, expect({ planned_sec: 0, width: 0, height: 0, section_gaps: chapters }))
    assert.deepEqual(issues.map(issue => issue.check), ['duration', 'black'],
      'the chapters supply the narration, and the black stretch is still the black stretch')
    assert.match(issues[0]!.verdict, /9354\.2s long/)
    assert.match(issues[0]!.verdict, /3329\.6s/)
    assert.match(issues[0]!.verdict, /\+6024\.6s/)
  })

  test('a plan-less final that is what its own settings asked for passes', () => {
    // The owner's own 6000 s after-scenes still and his 15 s fade post-roll, which is exactly what
    // this file is: chapters + clips + opening, with the whole clip span silent by design.
    const issues = finalCheckIssues(ss0063Length, expect({
      planned_sec: 0, width: 0, height: 0, section_gaps: chapters, after_narration_sec: SS0063_TAIL_SEC,
    }))
    assert.deepEqual(issues, [], JSON.stringify(issues))
  })

  /** The channel's own intro asset, measured: blackdetect 4.67–9.13 s of a 9.6 s clip. */
  const SS0063_INTRO = {
    asset: '/assets/story-sprout-assets/Story Sprout - Intro Video.mp4',
    window: { start_sec: 0, end_sec: 9.633 },
    black: [{ start_sec: 4.67, end_sec: 9.13 }],
  }

  test('the whole SS0063 shape — its own clips, its own intro — passes', () => {
    // Everything the file carries, against everything the episode's own settings say: 9354.2 s of
    // chapters + a 6000 s still + a 15 s post-roll, a 100-minute silent span that IS that still, and
    // the black that is the intro asset's own. Nothing here is a fault.
    const issues = finalCheckIssues(ss0063, expect({
      planned_sec: 0, width: 0, height: 0, section_gaps: chapters,
      after_narration_sec: SS0063_TAIL_SEC, intro: SS0063_INTRO,
    }))
    assert.deepEqual(issues, [], JSON.stringify(issues))
  })

  test('a plan-less final past even its own clips is still a length fault', () => {
    // The same settings, a file half an hour longer than they ask for: the tail is no longer an
    // ending, it is length the video should not have.
    const duration = 9354.208333 + 1800
    const issues = finalCheckIssues(
      { ...ss0063Length, duration_sec: duration, video_sec: duration, audio_sec: duration,
        silence: [{ start_sec: 3338.882789, end_sec: duration }] },
      expect({ planned_sec: 0, width: 0, height: 0, section_gaps: chapters, after_narration_sec: SS0063_TAIL_SEC }),
    )
    assert.deepEqual(issues.map(issue => issue.check), ['duration'])
    assert.match(issues[0]!.verdict, /9344\.6s/)
  })

  test('the black inside the branded intro is the owner\'s own content, not a fault', () => {
    // The channel's own intro asset, measured: blackdetect 4.67–9.13 s of a 9.6 s clip, which becomes
    // 4.75–9.208 s in the file after `prepareIntroClip`'s 24 fps encode — the very stretch the check
    // stopped SS0063 for. Owner, 2026-10-20: *"yes. it's my own settings."*
    assert.deepEqual(
      finalCheckIssues(ss0063, expect({
        planned_sec: 0, width: 0, height: 0, section_gaps: chapters,
        after_narration_sec: SS0063_TAIL_SEC, intro: SS0063_INTRO,
      })),
      [],
    )
  })

  test('a DIFFERENT intro with no black over the same window still stops', () => {
    // The exemption is about THIS episode's intro asset containing THIS black — never about the
    // stretch sitting in an opening. The same file, the same window, an intro that is not black
    // there: the black is the render's own and it stops, exactly as it did before this rule.
    const issues = finalCheckIssues(ss0063, expect({
      planned_sec: 0, width: 0, height: 0, section_gaps: chapters, after_narration_sec: SS0063_TAIL_SEC,
      intro: { asset: '/assets/another-intro.mp4', window: { start_sec: 0, end_sec: 9.633 }, black: [] },
    }))
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
    assert.match(issues[0]!.verdict, /black stretch at 0:05/)
    // An intro asset nobody has measured says nothing either: no measurement, no exemption.
    assert.deepEqual(
      finalCheckIssues(ss0063, expect({
        planned_sec: 0, width: 0, height: 0, section_gaps: chapters, after_narration_sec: SS0063_TAIL_SEC,
        intro: { asset: '/assets/another-intro.mp4', window: { start_sec: 0, end_sec: 9.633 } },
      })).map(issue => issue.check),
      ['black'],
    )
  })

  test('black in the scenes is still a fault, intro or no intro', () => {
    const intro = {
      asset: '/assets/intro.mp4',
      window: { start_sec: 0, end_sec: 9.633 },
      black: [{ start_sec: 4.67, end_sec: 9.13 }],
    }
    // A black stretch of the same length, 20 minutes into the scenes: the intro's window has nothing
    // to do with it, and the intro's own black does not cover it.
    const issues = finalCheckIssues(
      { ...ss0063, black: [{ start_sec: 1200, end_sec: 1204.5 }] },
      expect({ planned_sec: 0, width: 0, height: 0, section_gaps: chapters, after_narration_sec: SS0063_TAIL_SEC, intro }),
    )
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
    assert.match(issues[0]!.verdict, /black stretch at 20:00/)
    // And a stretch inside the intro's window that the asset is NOT black over is reported too.
    assert.deepEqual(
      finalCheckIssues(
        { ...ss0063, black: [{ start_sec: 0.2, end_sec: 4.4 }] },
        expect({ planned_sec: 0, width: 0, height: 0, section_gaps: chapters, after_narration_sec: SS0063_TAIL_SEC, intro }),
      ).map(issue => issue.check),
      ['black'],
    )
  })

  test('a short silent ending still never holds', () => {
    // The owner's standing rule, unchanged: a video that ends in a short silence is fine.
    const duration = 9354.208333
    const issues = finalCheckIssues(
      { ...ss0063Length, duration_sec: duration, video_sec: duration, audio_sec: duration,
        silence: [{ start_sec: duration - 12, end_sec: duration }] },
      expect({ planned_sec: 0, width: 0, height: 0, section_gaps: chapters, after_narration_sec: SS0063_TAIL_SEC }),
    )
    assert.deepEqual(issues, [])
    // And with no plan at all to measure against, a short ending is not a fault either.
    assert.deepEqual(
      finalCheckIssues({ ...legacy, silence: [{ start_sec: 9149 - 12, end_sec: 9149 }] }, noPlan()),
      [],
    )
  })

  /**
   * A render this sidecar DOES know about, made with the same channel preset: the 6000 s still sits
   * between the narration and the closing tail, so the tail's window starts ~100 minutes after the
   * words stop. Reading that window as the speech end put every silent second of the still "inside
   * the speech" — the same false hold the owner's decision is about, on a final that recorded its
   * own plan.
   */
  test('a still clip between the narration and the tail is not a silence inside the speech', () => {
    const plan = expect({
      planned_sec: 640, width: 320, height: 180,
      tail: { sec: 15, from_end_sec: 0 },
      speech_end_sec: 525,
    })
    const file = {
      duration_sec: 640, video_sec: 640, audio_sec: 640, width: 320, height: 180, tail_lufs: null,
      black: [], silence: [{ start_sec: 525, end_sec: 640 }],
    }
    assert.deepEqual(finalCheckIssues(file, plan), [], 'the 100 s still and the 15 s tail, both silent by design')
    // A silence that really is inside the speech is still reported.
    assert.deepEqual(
      finalCheckIssues({ ...file, silence: [{ start_sec: 300, end_sec: 320 }] }, plan).map(issue => issue.check),
      ['silence'],
    )
    // And the planned pauses are still counted back from where the words actually stop: the pause
    // before the last section sits at 220–225 s, not 100 s later where the tail's window begins.
    // The override drops the threshold under this pause's 5.05 s so the proof is the PLANNED GAP
    // doing the exempting, not the default 10 s threshold accepting it.
    assert.deepEqual(
      finalCheckIssues(
        { ...file, silence: [{ start_sec: 220.2, end_sec: 225.25 }] },
        { ...plan, section_gaps: { gap_sec: 5, durations_sec: [100, 200, 300] } },
        { silence_min_sec: 2 },
      ),
      [],
    )
  })

  test('a silent ending far longer than any closing tail is a length fault on its own', () => {
    // Nothing records a chapter plan either — but a 10-minute silent ending is not how a video ends,
    // and it is length the file should not have, not a gap in speech the check cannot place.
    const duration = 9149
    const issues = finalCheckIssues(
      { ...legacy, duration_sec: duration, video_sec: duration, audio_sec: duration, silence: [{ start_sec: duration - 600, end_sec: duration }] },
      noPlan(),
    )
    assert.deepEqual(issues.map(issue => issue.check), ['duration'])
  })

  test('a plan-less final that is its chapters plus an opening and a short silent ending passes', () => {
    // The ordinary shape, and the owner's rule: chapters, a branded opening in front of them, and a
    // short silent closing tail after them. Nothing here is a fault.
    const duration = CHAPTERS_SEC + 35 + 15
    const issues = finalCheckIssues(
      { duration_sec: duration, video_sec: duration, audio_sec: duration, width: 1920, height: 1080,
        tail_lufs: null, black: [], silence: [{ start_sec: duration - 15, end_sec: duration }] },
      expect({ planned_sec: 0, width: 0, height: 0, section_gaps: chapters }),
    )
    assert.deepEqual(issues, [])
  })

  test('a plan-less final of about its own chapters, with no silence at all, passes too', () => {
    const duration = CHAPTERS_SEC + 40
    assert.deepEqual(
      finalCheckIssues(
        { duration_sec: duration, video_sec: duration, audio_sec: duration, width: 1920, height: 1080,
          tail_lufs: null, black: [], silence: [] },
        expect({ planned_sec: 0, width: 0, height: 0, section_gaps: chapters }),
      ),
      [],
    )
  })

  test('a silence the check cannot place is reported as unknown, never as speech', () => {
    const issues = finalCheckIssues({ ...legacy, silence: [{ start_sec: 4000, end_sec: 4011 }] }, noPlan())
    assert.deepEqual(issues.map(issue => issue.check), ['silence'])
    assert.match(issues[0]!.verdict, /speech end is not recorded/)
    assert.doesNotMatch(issues[0]!.verdict, /inside the speech/)
  })

  test('a recorded speech end keeps the old verdicts', () => {
    const inside = finalCheckIssues(
      { ...legacy, silence: [{ start_sec: 9000, end_sec: 9011 }] },
      { ...noPlan(), speech_end_sec: 9140 },
    )
    assert.deepEqual(inside.map(issue => issue.check), ['silence'])
    assert.match(inside[0]!.verdict, /inside the speech/)
    // A silence that starts after the recorded speech end is not inside it either.
    assert.deepEqual(finalCheckIssues(legacy, { ...noPlan(), speech_end_sec: 9100 }), [])
  })

  test('the Scene Plan supplies the speech end for a file that has none of its own', () => {
    // EP0006's own numbers: merged narration 9143.984 s, last stitched cue 9143.941 s.
    assert.equal(
      speechEndSecFromScenePlan({
        source_merged_audio: { duration_sec: 9143.984 },
        source_timeline: { last_cue_end_sec: 9143.941 },
      }),
      9143.984,
      'the merged narration the plan was timed against is the better answer',
    )
    assert.equal(speechEndSecFromScenePlan({ source_timeline: { last_cue_end_sec: 9143.941 } }), 9143.941)
    assert.equal(speechEndSecFromScenePlan({}), 0, 'no plan, no claim')
    assert.equal(speechEndSecFromScenePlan(null), 0)

    // And the file is then judged against it: the whole 5.0 s is after the narration, so the check
    // has nothing to report.
    assert.deepEqual(finalCheckIssues(legacy, { ...noPlan(), speech_end_sec: 9143.984 }), [])
  })

  test('a known closing tail is still fine, and the silence inside it is not reported', () => {
    assert.deepEqual(
      finalCheckIssues(legacy, expect({ planned_sec: 9149, width: 0, height: 0, tail: { sec: 20, from_end_sec: 0 } })),
      [],
    )
  })

  test('the thresholds are knobs: the same file passes with the black floor raised', () => {
    const run = { start_sec: 3, end_sec: 4.5 }
    assert.deepEqual(
      finalCheckIssues({ ...actual, black: [run] }, plan(), { black_min_sec: 1 }).map(issue => issue.check),
      ['black'],
    )
    assert.deepEqual(finalCheckIssues({ ...actual, black: [run] }, plan(), { black_min_sec: 5 }), [])
  })

  test('the tail window follows the tail where the render actually put it', () => {
    assert.deepEqual(tailWindow(100, { sec: 25, from_end_sec: 0 }), { start_sec: 75, end_sec: 100 })
    // An outro after the tail pushes it earlier rather than to the file's end.
    assert.deepEqual(tailWindow(100, { sec: 25, from_end_sec: 10 }), { start_sec: 65, end_sec: 90 })
    assert.equal(tailWindow(100, { sec: 0, from_end_sec: 0 }), null)
  })
})

describe('reading ffmpeg back', () => {
  test('blackdetect runs are read with their start and end', () => {
    assert.deepEqual(
      parseBlackdetect('[Parsed_blackdetect_0 @ 0x1] black_start:2 black_end:5.1 black_duration:3.1\n'),
      [{ start_sec: 2, end_sec: 5.1 }],
    )
    assert.deepEqual(parseBlackdetect('nothing here'), [])
  })

  test('a silence that runs to the end of the file is closed at the file length', () => {
    const stderr = '[Parsed_silencedetect_0 @ 0x1] silence_start: 5\n'
    assert.deepEqual(parseSilencedetect(stderr, 8), [{ start_sec: 5, end_sec: 8 }])
    assert.deepEqual(
      parseSilencedetect('[x] silence_start: 5\n[x] silence_end: 7.5 | silence_duration: 2.5\n', 8),
      [{ start_sec: 5, end_sec: 7.5 }],
    )
  })

  test('closing music is wanted only when the preset asks for it', () => {
    assert.equal(closingMusicWanted({ closing_music: { duck_release_sec: 2 } }), true)
    assert.equal(closingMusicWanted({ closing_music: { volume: 0 } }), false)
    assert.equal(closingMusicWanted({ behavior: 'black-screen', tail_seconds: 25 }), false)
    assert.equal(closingMusicWanted(undefined), false)
  })
})

describe('a verdict goes stale when the video does', () => {
  test('the stored verdict is fresh, then stale the moment the file is rewritten', async () => {
    const copy = path.join(dir, 'stale-check.mp4')
    await fs.copyFile(goodFile, copy)

    const result = await runFinalCheck(copy, expect())
    await storeFinalCheck(copy, result)
    assert.equal(await fs.readFile(finalCheckPath(copy), 'utf-8').then(t => JSON.parse(t).passed), true)

    const fresh = await readStoredFinalCheck(copy)
    assert.equal(fresh?.stale, false)
    assert.equal(finalCheckVerdict(fresh), null)
    assert.equal(finalCheckSummary(fresh), 'Final check: passed')

    // A re-render replaces the file: the old verdict describes bytes that are no longer there.
    await fs.appendFile(copy, Buffer.alloc(16))
    const stale = await readStoredFinalCheck(copy)
    assert.equal(stale?.stale, true)
    assert.match(finalCheckVerdict(stale)!, /changed since its final check/)
    assert.match(finalCheckSummary(stale), /out of date/)
  })

  test('the identity an upload answers about is the verdict and the bytes, not just the path', async () => {
    const copy = path.join(dir, 'identity-check.mp4')
    await fs.copyFile(goodFile, copy)
    const result = await runFinalCheck(copy, expect())
    await storeFinalCheck(copy, result)

    const fresh = await readStoredFinalCheck(copy)
    assert.deepEqual(finalCheckIdentity(fresh), {
      checked_at: result.checked_at,
      file_size: result.file.size,
      file_mtime_ms: result.file.mtime_ms,
    })
    assert.equal(finalCheckIdentityMatches(fresh, result.checked_at), true)
    assert.equal(finalCheckIdentityMatches(fresh, 'a different check'), false, 'a replaced verdict is not this one')
    assert.equal(finalCheckIdentityMatches(null, result.checked_at), false, 'no verdict, nothing to match')

    await fs.appendFile(copy, Buffer.alloc(16))
    assert.equal(
      finalCheckIdentityMatches(await readStoredFinalCheck(copy), result.checked_at),
      false,
      'the bytes moved after the check, so the verdict no longer describes them',
    )
  })

  test('a final with no verdict is not refused — the row says so and the owner can run it', () => {
    assert.equal(finalCheckVerdict(null), null)
    assert.equal(finalCheckSummary(null), 'Final check: not run yet')
  })

  test('a failed verdict names the first problem and counts the rest', () => {
    const stored = {
      result: {
        checked_at: '', file: { size: 0, mtime_ms: 0 }, expected: expect(), actual: {
          duration_sec: 0, video_sec: null, audio_sec: null, width: 0, height: 0,
          tail_lufs: null, black: [], silence: [],
        },
        passed: false,
        issues: [{ check: 'black', verdict: 'there is a black stretch' }, { check: 'av', verdict: 'the clocks differ' }],
      } as any,
      stale: false,
    }
    assert.equal(finalCheckVerdict(stored), 'there is a black stretch (and 1 more problem)')
    assert.equal(finalCheckSummary(stored), 'Final check: 2 problems — there is a black stretch')
  })
})

/**
 * Night Atlas History EP0014, 2026-10-20: the check called a 5.0 s silence at 1:28:25 "inside the
 * speech". It was the planned 5 s pause between Chapter 10 and Chapter 11 (`gap_duration_s: 5`),
 * detected as 5.007 s only because silencedetect's threshold is the same 5 s.
 */
describe('planned pauses between sections', () => {
  // Three sections of 100, 200 and 300 s with 5 s pauses and an 8 s lead-in: speech ends at 618 s,
  // the pauses sit at 108-113 s and 313-318 s.
  const gaps = { gap_sec: 5, durations_sec: [100, 200, 300] }
  const actual = {
    duration_sec: 640, video_sec: 640, audio_sec: 640, width: 320, height: 180,
    tail_lufs: null, black: [], silence: [] as Array<{ start_sec: number; end_sec: number }>,
  }
  const plan = (over: Partial<FinalCheckExpectation> = {}) => expect({
    planned_sec: 640, width: 320, height: 180, tail: { sec: 22, from_end_sec: 0 }, speech_end_sec: 618, ...over,
  })

  test('windows are counted back from the speech end', () => {
    assert.deepEqual(sectionGapWindows(gaps, 618), [{ start_sec: 313, end_sec: 318 }, { start_sec: 108, end_sec: 113 }])
  })

  test('a silence that is a planned pause is not a fault; the same silence elsewhere is', () => {
    const pause = { start_sec: 313.2, end_sec: 318.25 }
    const options = { silence_min_sec: 5 }
    assert.deepEqual(finalCheckIssues({ ...actual, silence: [pause] }, plan({ section_gaps: gaps }), options), [])
    const unplanned = finalCheckIssues({ ...actual, silence: [pause] }, plan(), options)
    assert.deepEqual(unplanned.map(issue => issue.check), ['silence'])
    const elsewhere = { start_sec: 200, end_sec: 205.1 }
    assert.deepEqual(
      finalCheckIssues({ ...actual, silence: [elsewhere] }, plan({ section_gaps: gaps }), options).map(issue => issue.check),
      ['silence'],
    )
  })

  test('a pause that runs into more silence than was planned is still reported', () => {
    const long = { start_sec: 313, end_sec: 326 }
    assert.deepEqual(
      finalCheckIssues({ ...actual, silence: [long] }, plan({ section_gaps: gaps })).map(issue => issue.check),
      ['silence'],
    )
  })

  test('the sidecar yields no pause for a single section, a zero gap, or a bad length', () => {
    assert.deepEqual(plannedSectionGapsFromSidecar({ sections: [{ duration_s: 10 }, { duration_s: 20 }], gap_duration_s: 5 }),
      { gap_sec: 5, durations_sec: [10, 20] })
    assert.equal(plannedSectionGapsFromSidecar({ sections: [{ duration_s: 10 }], gap_duration_s: 5 }), null)
    assert.equal(plannedSectionGapsFromSidecar({ sections: [{ duration_s: 10 }, { duration_s: 20 }], gap_duration_s: 0 }), null)
    assert.equal(plannedSectionGapsFromSidecar({ sections: [{ duration_s: 10 }, {}], gap_duration_s: 5 }), null)
    assert.equal(plannedSectionGapsFromSidecar(null), null)
  })

  test('the pauses are read from an episode folder, and a folder without the sidecar plans none', async () => {
    const folder = await fs.mkdtemp(path.join(dir, 'chapters-'))
    assert.equal(await readPlannedSectionGaps(folder), null)
    await fs.writeFile(path.join(folder, 'audio_chapters.json'),
      JSON.stringify({ sections: [{ duration_s: 100 }, { duration_s: 200 }], gap_duration_s: 5 }))
    assert.deepEqual(await readPlannedSectionGaps(folder), { gap_sec: 5, durations_sec: [100, 200] })
  })
})

/**
 * The intentional text title card (Origin Field EP0031, 2026-11-08).
 *
 * Its black background is content the episode asked for, so the check must not call it a gap — but
 * the exemption is never a blanket window. It requires a self-consistent raster proof AND a finished
 * frame that really shows non-blank text inside the safe margins. A blank, clipped, unproven or
 * out-of-window card is still a black fault.
 */
describe('the intentional text title card', () => {
  const W = 1920
  const H = 1080
  const MARGIN = 54
  const TEXT = 'When Mountain Ranges Rose Through the Atmosphere | Documentary for Sleep'
  const bounds = { left: 96, top: 420, right: 1824, bottom: 660 }

  function proof(over: Partial<FinalCheckTitleCard['proof']> = {}): FinalCheckTitleCard['proof'] {
    return {
      text: TEXT,
      text_sha256: crypto.createHash('sha256').update(TEXT).digest('hex'),
      rendered_sha256: 'a'.repeat(64),
      bounds,
      frame: { width: W, height: H },
      safe_margin_px: MARGIN,
      nonblank_pixels: 12_345,
      font_id: 'inter',
      font_px: 58,
      lines: 2,
      ...over,
    }
  }

  function card(over: Partial<FinalCheckTitleCard> = {}): FinalCheckTitleCard {
    return { window: { start_sec: 8, end_sec: 13 }, proof: proof(), ...over }
  }

  function actual(
    black: Array<{ start_sec: number; end_sec: number }>,
    measured: FinalCheckTitleCard['proof'] | null = proof(),
    measureError?: string,
  ) {
    return {
      duration_sec: 20,
      video_sec: 20,
      audio_sec: null,
      width: W,
      height: H,
      tail_lufs: null,
      black,
      silence: [] as Array<{ start_sec: number; end_sec: number }>,
      ...(measureError
        ? { title_card: { measured_at_sec: 10.5, nonblank_pixels: 0, bounds: null, frame: { width: 0, height: 0 }, error: measureError } }
        : {
          title_card: {
            measured_at_sec: 10.5,
            nonblank_pixels: measured?.nonblank_pixels ?? 0,
            bounds: measured?.bounds ?? null,
            frame: measured?.frame ?? { width: W, height: H },
          },
        }),
    }
  }

  const plan = (over: Partial<FinalCheckExpectation> = {}) => expect({
    planned_sec: 20, width: W, height: H, title_card: card(), ...over,
  })

  test('a drawn, contained title excuses exactly its own black window', () => {
    const issues = finalCheckIssues(actual([{ start_sec: 8, end_sec: 13 }]), plan())
    assert.deepEqual(issues, [])
  })

  test('a blank finished card is still black', () => {
    const issues = finalCheckIssues(actual([{ start_sec: 8, end_sec: 13 }], null), plan())
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
  })

  test('a clipped finished card is still black', () => {
    const clipped = proof({ bounds: { left: 0, top: 420, right: 1824, bottom: 660 } })
    const issues = finalCheckIssues(actual([{ start_sec: 8, end_sec: 13 }], clipped), plan())
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
  })

  test('a proof whose hash does not describe its text excuses nothing', () => {
    const issues = finalCheckIssues(
      actual([{ start_sec: 8, end_sec: 13 }]),
      plan({ title_card: card({ proof: proof({ text_sha256: 'not-the-hash' }) }) }),
    )
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
  })

  test('a proof with no rendered raster excuses nothing', () => {
    const issues = finalCheckIssues(
      actual([{ start_sec: 8, end_sec: 13 }]),
      plan({ title_card: card({ proof: proof({ rendered_sha256: '' }) }) }),
    )
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
  })

  test('black outside the card window is still black', () => {
    const issues = finalCheckIssues(actual([{ start_sec: 14, end_sec: 19 }]), plan())
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
  })

  test('a card frame that could not be measured excuses nothing', () => {
    const issues = finalCheckIssues(actual([{ start_sec: 8, end_sec: 13 }], null, 'decode failed'), plan())
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
  })

  test('a contained frame that is not the proven card is still black', () => {
    // Same window and non-blank, but the ink sits somewhere the proof never drew it.
    const elsewhere = proof({ bounds: { left: 300, top: 420, right: 1500, bottom: 660 } })
    const issues = finalCheckIssues(actual([{ start_sec: 8, end_sec: 13 }], elsewhere), plan())
    assert.deepEqual(issues.map(issue => issue.check), ['black'])
  })

  test('the pure predicate agrees, and a proof at the safe edge is still inside', () => {
    const measured = actual([{ start_sec: 8, end_sec: 13 }]).title_card
    assert.equal(isTitleCardBlack({ start_sec: 8, end_sec: 13 }, card(), measured), true)
    const edge = proof({ bounds: { left: MARGIN, top: MARGIN, right: W - MARGIN, bottom: H - MARGIN } })
    const edgeMeasured = actual([{ start_sec: 8, end_sec: 13 }], edge).title_card
    assert.equal(isTitleCardBlack({ start_sec: 8, end_sec: 13 }, card({ proof: edge }), edgeMeasured), true)
  })

  test('a resumed expectation keeps the card proof, so the check does not weaken on resume', async () => {
    const videoPath = path.join(dir, 'title-card-resume.mp4')
    writeFileSync(videoPath, 'not a real video, only an identity')
    const stat = await fs.stat(videoPath)
    const expected = plan()
    await storeFinalCheck(videoPath, {
      checked_at: new Date().toISOString(),
      file: { size: stat.size, mtime_ms: stat.mtimeMs },
      expected,
      actual: actual([{ start_sec: 8, end_sec: 13 }]),
      passed: true,
      issues: [],
    })
    const stored = await readStoredFinalCheck(videoPath)
    assert.equal(stored?.stale, false)
    assert.deepEqual(freshStoredExpectation(stored)?.title_card, expected.title_card)
  })
})

/**
 * The same decision, measured on a real encoded file: the frame at the card's midpoint must show
 * ink. A card that encoded blank fails even though its expectation says a title was drawn.
 */
describe('the title card frame is measured on the finished file', () => {
  function cardVideo(withText: boolean): string {
    const draw = withText ? ",drawbox=c=white:t=fill:enable='between(t,2,5)':x=60:y=80:w=60:h=10" : ''
    return ffmpeg([
      '-f', 'lavfi', '-i', `color=c=blue:s=320x180:r=10:d=2`,
      '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=10:d=3`,
      '-f', 'lavfi', '-i', `color=c=blue:s=320x180:r=10:d=3`,
      '-filter_complex', `[0:v][1:v][2:v]concat=n=3:v=1:a=0${draw}[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    ], withText ? 'title-card-drawn.mp4' : 'title-card-blank.mp4')
  }

  const cardExpectation = (): FinalCheckTitleCard => ({
    window: { start_sec: 2, end_sec: 5 },
    proof: {
      text: 'A title card',
      text_sha256: crypto.createHash('sha256').update('A title card').digest('hex'),
      rendered_sha256: 'b'.repeat(64),
      bounds: { left: 60, top: 80, right: 120, bottom: 90 },
      frame: { width: 320, height: 180 },
      safe_margin_px: 24,
      nonblank_pixels: 600,
      font_id: 'inter',
      font_px: 30,
      lines: 1,
    },
  })

  test('a drawn card passes; the same window encoded blank still fails', async () => {
    const drawn = await runFinalCheck(cardVideo(true), expect({
      planned_sec: 8, width: 320, height: 180, title_card: cardExpectation(),
    }))
    assert.deepEqual(drawn.issues, [], JSON.stringify(drawn.actual))
    assert.ok((drawn.actual.title_card?.nonblank_pixels ?? 0) > 0)
    assert.ok(drawn.actual.title_card?.bounds, 'the finished frame has measured ink')

    const blank = await runFinalCheck(cardVideo(false), expect({
      planned_sec: 8, width: 320, height: 180, title_card: cardExpectation(),
    }))
    assert.deepEqual(blank.issues.map(issue => issue.check), ['black'])
    assert.equal(blank.actual.title_card?.nonblank_pixels, 0)
  })
})
