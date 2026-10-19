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
import fs from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  closingMusicWanted,
  finalCheckIssues,
  finalCheckPath,
  finalCheckSummary,
  finalCheckVerdict,
  parseBlackdetect,
  parseSilencedetect,
  readStoredFinalCheck,
  runFinalCheck,
  speechEndSecFromScenePlan,
  storeFinalCheck,
  tailWindow,
  type FinalCheckExpectation,
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

  test('a silence the check cannot place is reported as unknown, never as speech', () => {
    const issues = finalCheckIssues({ ...legacy, silence: [{ start_sec: 4000, end_sec: 4010 }] }, noPlan())
    assert.deepEqual(issues.map(issue => issue.check), ['silence'])
    assert.match(issues[0]!.verdict, /speech end is not recorded/)
    assert.doesNotMatch(issues[0]!.verdict, /inside the speech/)
  })

  test('a recorded speech end keeps the old verdicts', () => {
    const inside = finalCheckIssues(
      { ...legacy, silence: [{ start_sec: 9000, end_sec: 9010 }] },
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
