/**
 * A plan-less final's expectation, frozen onto the file it belongs to (2026-10-20).
 *
 * The owner's decision keeps every already-made Sprout final on its long silent still tail and its
 * branded intro, while FUTURE episodes drop that 6000 s `after_scenes` clip. A final from before the
 * 1.4.327 plan sidecar records no plan of its own, so once that preset changes nothing on disk says
 * what the file was made to be — and a re-check would measure SS0063's 9354 s against a ~15 s tail
 * and STOP a file the owner said to keep. So the shape is written down while the settings can still
 * be shown to be the ones that produced it, and read back from the record ever after.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import type { FinalCheckExpectation } from '../lib/final-video-check.js'

let dir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let planlessExpectationFor: typeof import('../services/final-check-expectation.js')['planlessExpectationFor']
let freezeExistingPlanlessFinals: typeof import('../services/final-check-expectation.js')['freezeExistingPlanlessFinals']
let expectationFromFrozenShape: typeof import('../services/final-check-expectation.js')['expectationFromFrozenShape']
let frozenExpectationPath: typeof import('../lib/final-video-check.js')['frozenExpectationPath']
let readFrozenShape: typeof import('../lib/final-video-check.js')['readFrozenShape']
let finalCheckIssues: typeof import('../lib/final-video-check.js')['finalCheckIssues']
let resolveEpisodePathsByCode: typeof import('../services/utils.js')['resolveEpisodePathsByCode']
let resolveScenePlanPath: typeof import('../services/utils.js')['resolveScenePlanPath']

/** A real 3 s intro clip with 2.5 s of black in it — the owner's own asset, in miniature. */
let introAsset: string

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  dir = mkdtempSync(path.join(os.tmpdir(), 'final-check-freeze-'))
  pm = await import('../services/project-manager.js')
  ;({ planlessExpectationFor, freezeExistingPlanlessFinals, expectationFromFrozenShape } =
    await import('../services/final-check-expectation.js'))
  ;({ frozenExpectationPath, readFrozenShape, finalCheckIssues } = await import('../lib/final-video-check.js'))
  ;({ resolveEpisodePathsByCode, resolveScenePlanPath } = await import('../services/utils.js'))
  introAsset = path.join(dir, 'Story Sprout - Intro Video.mp4')
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=3,drawbox=c=black:t=fill:enable=\'gte(t,0.5)\'',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    introAsset,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
})

after(async () => {
  rmSync(dir, { recursive: true, force: true })
  await cleanup()
})

/** The channel's own Video Assembly bundle: a 6000 s after-scenes still and a 15 s fade post-roll. */
function sproutConfig(introAsset: string, clipSec = 6000) {
  return {
    video_bundle_presets: [{
      id: 'preset-1781671791580',
      name: 'Story Sprout - Video Assembly',
      data: {
        fallback: {
          intro: {
            enabled: true,
            video_path: introAsset,
            outro: { enabled: false, video_path: '' },
            timeline_clips: clipSec > 0
              ? [{
                id: 'clip-1776875775168-cl5s', kind: 'static', anchor: 'after_scenes', enabled: true,
                image_path: path.join(dir, 'still.png'), duration_sec: clipSec,
              }]
              : [],
          },
          timeline: { post_audio: { behavior: 'fade-to-black', fade_duration: 15, tail_seconds: 4 } },
        },
      },
    }],
    video_bundle_last_preset: 'preset-1781671791580',
  }
}

interface PlanlessChannel {
  slug: string
  episodeDir: string
  videoPath: string
  configPath: string
}

/**
 * A channel whose preset asks for the 6000 s still, with one plan-less final already on disk. The
 * final is written AFTER the settings, so the settings can be shown to be the ones that produced it.
 */
async function planlessChannel(opts: { clipSec?: number; finalAgeSec?: number } = {}): Promise<PlanlessChannel> {
  const project = await pm.createProject({
    name: `Freeze ${Math.random().toString(36).slice(2, 7)}`, episode_prefix: 'EP', episode_digits: 3,
  })
  const slug = project.slug
  await pm.updateConfig(slug, sproutConfig(introAsset, opts.clipSec ?? 6000) as any)

  const projectDir = pm.getProjectDir(slug)!
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: 'i-1', title: 'Test', logline: 'l', themes: [], suggested_chapters: 1, suggested_length: '1 min', mood: 'm',
      status: 'accepted', episode_code: 'EP001', generated_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z',
      batch_id: 'imported', model_used: 'imported',
    }],
    next_episode_number: 2, recycled_numbers: [],
  }))
  const paths = await resolveEpisodePathsByCode(slug, 'EP001')
  await fs.mkdir(paths.video_dir, { recursive: true })
  const videoPath = path.join(paths.video_dir, 'EP001_final_video.mp4')
  await fs.writeFile(videoPath, 'not really 700 MB of video, but the check only stats it')

  // Deterministic clocks: the final's mtime is what says whether the settings could have moved since.
  const when = new Date(Date.now() - (opts.finalAgeSec ?? 0) * 1000)
  await fs.utimes(videoPath, when, when)
  return { slug, episodeDir: paths.episode_dir, videoPath, configPath: path.join(projectDir, 'config.json') }
}

async function ref(channel: PlanlessChannel) {
  const stat = await fs.stat(channel.videoPath)
  return {
    slug: channel.slug, episode_code: 'EP001', episode_dir: channel.episodeDir,
    video_path: channel.videoPath, mtime_ms: stat.mtimeMs,
  }
}

/** Story Sprout SS0063's own 16 sections and their 5 s pauses. */
const chapters = {
  gap_sec: 5,
  durations_sec: [
    192.214785, 199.366531, 227.648435, 203.174603, 144.2, 121.68, 128.000042, 233.081905,
    286.53424, 237.586576, 185.945397, 201.549206, 198.205533, 232.617506, 229.506032, 233.267664,
  ],
}

/** SS0063's own measured final: 9354.2 s, a 100-minute silent span, and the intro's own black. */
const SS0063_ACTUAL = {
  duration_sec: 9354.208333, video_sec: 9354.208333, audio_sec: 9354.202993, width: 1920, height: 1080,
  tail_lufs: null,
  black: [{ start_sec: 0.5, end_sec: 3 }],
  silence: [{ start_sec: 3338.882789, end_sec: 9354.20517 }],
}

/** What the check is asked to measure a plan-less final against, minus the frozen shape itself. */
const planlessExpectation = (over: Partial<FinalCheckExpectation> = {}): FinalCheckExpectation => ({
  planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
  width: 0, height: 0, subtitles_path: null, section_gaps: chapters, ...over,
})

describe("freezing a plan-less final's expectation", () => {
  test('the shape is taken once from the settings, and survives the preset changing under it', async () => {
    const channel = await planlessChannel()
    const frozen = await planlessExpectationFor(await ref(channel))
    assert.equal(frozen.kind, 'frozen')
    if (frozen.kind !== 'frozen') return
    assert.equal(frozen.shape.after_narration_sec, 6015, '6000 s of still + a 15 s fade post-roll')
    assert.equal(frozen.shape.source, 'settings')
    assert.equal(frozen.shape.intro?.asset, introAsset)
    assert.ok((frozen.shape.intro?.black?.length ?? 0) > 0, 'the intro asset was measured, and its black frozen with it')

    // Production then drops the 6000 s clip for future episodes: the preset no longer describes this
    // file at all.
    await pm.updateConfig(channel.slug, sproutConfig(introAsset, 0) as any)

    const after = await planlessExpectationFor(await ref(channel))
    assert.equal(after.kind, 'frozen')
    if (after.kind !== 'frozen') return
    assert.equal(after.shape.after_narration_sec, 6015, 'the frozen shape, not the preset that no longer has the clip')

    // And the final it was made to be still passes — its own still clip, its own intro's black.
    assert.deepEqual(
      finalCheckIssues(SS0063_ACTUAL, planlessExpectation(expectationFromFrozenShape(after.shape))),
      [],
    )
  })

  test("a final with no freeze whose settings moved is unknown, never measured against today's preset", async () => {
    // Rendered an hour ago, and the preset was changed after it: nothing can say what it was made to
    // be, so the check says exactly that instead of inventing an answer.
    const channel = await planlessChannel({ finalAgeSec: 3600 })
    const settled = await planlessExpectationFor(await ref(channel))
    assert.equal(settled.kind, 'unknown')
    if (settled.kind !== 'unknown') return
    assert.match(settled.reason, /settings changed after this video was rendered/)

    const issues = finalCheckIssues(SS0063_ACTUAL, planlessExpectation({ expectation_unknown: settled.reason }))
    assert.equal(issues[0]!.check, 'expectation', 'the row leads with what is unknown')
    assert.match(issues[0]!.verdict, /cannot be checked against what it was made for/)
    assert.match(issues[0]!.verdict, /settings changed after this video was rendered/)
    assert.ok(issues.length > 0, '"unknown" is not a pass')
    assert.deepEqual(issues.map(issue => issue.check), ['expectation', 'black'],
      'the length is not judged, and the black nobody can place is still reported')
    assert.ok(!issues.some(issue => issue.check === 'duration'), 'the unknown length is not called a length fault')
  })

  test('nothing is written when the settings cannot be shown to be the ones that made the file', async () => {
    const channel = await planlessChannel({ finalAgeSec: 3600 })
    await planlessExpectationFor(await ref(channel))
    assert.equal(await readFrozenShape(channel.videoPath), null, 'no freeze, and no file claiming one')
  })

  test('re-freezing writes nothing: the record it already has is the answer', async () => {
    const channel = await planlessChannel()
    const first = await planlessExpectationFor(await ref(channel))
    assert.equal(first.kind, 'frozen')
    const recordPath = frozenExpectationPath(channel.videoPath)
    const written = await fs.readFile(recordPath, 'utf-8')

    const again = await planlessExpectationFor(await ref(channel))
    assert.equal(again.kind, 'frozen')
    assert.equal(await fs.readFile(recordPath, 'utf-8'), written, 'the record is byte-identical')
    if (first.kind === 'frozen' && again.kind === 'frozen') {
      assert.equal(again.shape.frozen_at, first.shape.frozen_at, 'and it is still the freeze that was taken first')
    }
  })

  test('a rewritten final is not the one the freeze describes', async () => {
    const channel = await planlessChannel()
    assert.equal((await planlessExpectationFor(await ref(channel))).kind, 'frozen')
    // The final is re-rendered — same path, different bytes.
    await fs.writeFile(channel.videoPath, 'a second, longer render of the same episode')
    const stale = await readFrozenShape(channel.videoPath)
    assert.equal(stale?.stale, true, 'the freeze no longer describes these bytes')
    // ...and it is replaced by one about the file that is there now.
    const settled = await planlessExpectationFor(await ref(channel))
    assert.equal(settled.kind, 'frozen')
    assert.equal((await readFrozenShape(channel.videoPath))?.stale, false)
  })

  test("the intro window covers the opening the episode's own plan reserved", async () => {
    // The renderer trims or pads the intro clip to the Scene Plan's reserved opening when the plan
    // did not measure it, so the clip in the file is that long — and a window built from the asset
    // alone would be too short to cover the clip's own black.
    const channel = await planlessChannel()
    const planPath = await resolveScenePlanPath(channel.slug, 'EP001', channel.episodeDir)
    await fs.mkdir(path.dirname(planPath), { recursive: true })
    await fs.writeFile(planPath, JSON.stringify({ opening_mode: 'branded-opening', opening_reserved_sec: 12 }))

    const settled = await planlessExpectationFor(await ref(channel))
    assert.equal(settled.kind, 'frozen')
    if (settled.kind !== 'frozen') return
    assert.equal(settled.shape.intro?.window.end_sec, 12, 'the reserved 12 s opening, not the asset\'s own 3 s')
  })
})

describe('the boot sweep', () => {
  test('it freezes every plan-less final it finds, and leaves frozen ones exactly as they are', async () => {
    const channel = await planlessChannel()
    const sweep = await freezeExistingPlanlessFinals()
    assert.ok(sweep.planless >= 1, 'the final on disk was considered')
    assert.ok(sweep.frozen >= 1)
    assert.ok(sweep.records.includes(channel.videoPath), 'and the record it wrote is named in the result')
    const written = await fs.readFile(frozenExpectationPath(channel.videoPath), 'utf-8')

    // Idempotent: a second sweep writes nothing, so an answer a check was decided against cannot move.
    const again = await freezeExistingPlanlessFinals()
    assert.equal(again.frozen, 0)
    assert.ok(again.kept >= 1)
    assert.equal(await fs.readFile(frozenExpectationPath(channel.videoPath), 'utf-8'), written)
  })

  test('a sweep after the preset moved cannot freeze a final that was never frozen', async () => {
    const channel = await planlessChannel({ finalAgeSec: 3600 })
    const sweep = await freezeExistingPlanlessFinals()
    assert.ok(sweep.unknown >= 1, 'it is reported, not frozen against the new settings')
    assert.ok(sweep.unknown_finals.includes(channel.videoPath))
    assert.equal(await readFrozenShape(channel.videoPath), null)
  })
})
