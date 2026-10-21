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
let finalCheckPath: typeof import('../lib/final-video-check.js')['finalCheckPath']
let readFrozenShape: typeof import('../lib/final-video-check.js')['readFrozenShape']
let readStoredFinalCheck: typeof import('../lib/final-video-check.js')['readStoredFinalCheck']
let finalCheckIssues: typeof import('../lib/final-video-check.js')['finalCheckIssues']
let resolveEpisodePathsByCode: typeof import('../services/utils.js')['resolveEpisodePathsByCode']
let resolveScenePlanPath: typeof import('../services/utils.js')['resolveScenePlanPath']
let finalFreezeStates: typeof import('../services/final-check-expectation.js')['finalFreezeStates']
let shapingFingerprint: typeof import('../services/final-check-expectation.js')['shapingFingerprint']

/** A real 3 s intro clip with 2.5 s of black in it — the owner's own asset, in miniature. */
let introAsset: string

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  dir = mkdtempSync(path.join(os.tmpdir(), 'final-check-freeze-'))
  pm = await import('../services/project-manager.js')
  ;({ planlessExpectationFor, freezeExistingPlanlessFinals, expectationFromFrozenShape } =
    await import('../services/final-check-expectation.js'))
  ;({ frozenExpectationPath, finalCheckPath, readFrozenShape, readStoredFinalCheck, finalCheckIssues } =
    await import('../lib/final-video-check.js'))
  ;({ resolveEpisodePathsByCode, resolveScenePlanPath } = await import('../services/utils.js'))
  ;({ finalFreezeStates, shapingFingerprint } = await import('../services/final-check-expectation.js'))
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

async function ref(channel: PlanlessChannel, episodeCode = 'EP001') {
  const stat = await fs.stat(channel.videoPath)
  return {
    slug: channel.slug, episode_code: episodeCode, episode_dir: channel.episodeDir,
    video_path: channel.videoPath, mtime_ms: stat.mtimeMs,
  }
}

/** File A's own tail, intro and freeze stamp — the shape a verdict recorded for bytes that are gone. */
const A_TAIL_SEC = 1234.5
const A_INTRO_ASSET = '/assets/story-sprout-intro.mp4'
const A_FROZEN_AT = '2026-01-01T00:00:00.000Z'

/** A plan-less verdict that carries a shape, the way the render's or the route's own check writes one. */
const A_VERDICT: Partial<FinalCheckExpectation> = {
  after_narration_sec: A_TAIL_SEC,
  intro: { asset: A_INTRO_ASSET, window: { start_sec: 0, end_sec: 9.6 }, black: [] },
  frozen_at: A_FROZEN_AT,
}

/** Store a verdict for whatever is at `videoPath` right now, bound to those bytes the way a check does. */
async function storeVerdictFor(videoPath: string, expected: Partial<FinalCheckExpectation>): Promise<void> {
  const stat = await fs.stat(videoPath)
  await fs.writeFile(finalCheckPath(videoPath), JSON.stringify({
    checked_at: new Date().toISOString(),
    file: { size: stat.size, mtime_ms: stat.mtimeMs },
    expected: {
      planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
      width: 0, height: 0, subtitles_path: null, ...expected,
    },
    actual: {
      duration_sec: 1, video_sec: 1, audio_sec: 1, width: 320, height: 180,
      tail_lufs: null, black: [], silence: [],
    },
    passed: true, issues: [],
  }, null, 2))
}

/**
 * Replace the final with different bytes and leave the verdict where it was.
 *
 * This is what a render whose own check could not run leaves behind (`generators/video.ts`'s
 * `finalCheckFinalVideo` keeps the old sidecar when the check throws), and what importing a render
 * over an existing final does.
 */
async function replaceFinal(channel: PlanlessChannel, opts: { ageSec?: number } = {}): Promise<void> {
  await fs.appendFile(channel.videoPath, '\na second render of the same episode, and nobody checked it')
  if (opts.ageSec) {
    const when = new Date(Date.now() - opts.ageSec * 1000)
    await fs.utimes(channel.videoPath, when, when)
  }
}

/**
 * A finished render's own request, saved the way the durable queue leaves one.
 *
 * `routes/pipeline.ts` flattens the Video Assembly bundle into the job's params — `intro`,
 * `timeline_clips`, `post_audio` — so this is the exact instruction the render ran on, and the only
 * per-final record of the settings that produced a file. Written straight into the channel's
 * `jobs.json` as a finished job, which is what a completed render leaves and what the queue loads as
 * history rather than re-running.
 */
async function saveRenderRequest(channel: PlanlessChannel, opts: {
  /** When the request was made. */
  createdAt: string
  /** When the render that ran on it ended — the file is written, then checked, then the job ends. */
  finishedAt: string
  episodeId?: string
  clipSec?: number
  postAudio?: Record<string, unknown>
  status?: string
}): Promise<string> {
  const jobId = `job-${Math.random().toString(16).slice(2, 10)}`
  const episodeId = opts.episodeId ?? 'EP001'
  const jobsFile = path.join(pm.getProjectDir(channel.slug)!, 'jobs.json')
  const existing = await fs.readFile(jobsFile, 'utf-8').then(text => JSON.parse(text)).catch(() => ({ jobs: [] }))
  await fs.writeFile(jobsFile, JSON.stringify({
    jobs: [...(existing.jobs || []), {
      job_id: jobId, project_slug: channel.slug, type: 'video_assembly', episode_id: episodeId,
      title: `Pipeline: Final Video — ${episodeId}`, status: opts.status ?? 'done',
      created_at: opts.createdAt, started_at: opts.createdAt, finished_at: opts.finishedAt,
      error: null, output_lines: [],
      params: {
        episode_id: episodeId,
        intro: { enabled: true, video_path: introAsset },
        timeline_clips: (opts.clipSec ?? 6000) > 0
          ? [{
            id: 'clip-1776875775168-cl5s', kind: 'static', anchor: 'after_scenes', enabled: true,
            image_path: path.join(dir, 'still.png'), duration_sec: opts.clipSec ?? 6000,
          }]
          : [],
        post_audio: opts.postAudio ?? { behavior: 'fade-to-black', fade_duration: 15, tail_seconds: 4 },
      },
    }],
    stats: {},
  }))
  return jobId
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

/**
 * A verdict is evidence about the bytes it measured and about no others.
 *
 * File A's verdict carries A's own tail length and A's own intro. Once B has replaced A at the same
 * path, `readStoredFinalCheck` still returns that verdict — and reports it `stale`, because it is the
 * only thing that knows the file it measured is gone. Reading A's answer off it anyway is how one
 * final's shape gets certified for another: the sweep stamped A's `after_narration_sec` and `intro`
 * onto B's size and mtime, which made a freeze that no longer looks stale, and the on-demand check
 * measured B against A's plan (2026-10-20).
 */
describe("a verdict the final has outlived", () => {
  test("a stale verdict's shape is never frozen onto the file that replaced it", async () => {
    const channel = await planlessChannel()
    await storeVerdictFor(channel.videoPath, A_VERDICT)
    await replaceFinal(channel)
    assert.equal((await readStoredFinalCheck(channel.videoPath))?.stale, true,
      'the verdict is now about bytes that are gone')

    const sweep = await freezeExistingPlanlessFinals()

    assert.ok(sweep.records.includes(channel.videoPath), 'the final was still given an expectation')
    const frozen = await readFrozenShape(channel.videoPath)
    assert.equal(frozen?.stale, false, 'and it describes the bytes that are there now')
    assert.notEqual(frozen?.shape.after_narration_sec, A_TAIL_SEC, "file A's tail is not certified for B")
    assert.notEqual(frozen?.shape.intro?.asset, A_INTRO_ASSET, "file A's intro is not certified for B")
    assert.notEqual(frozen?.shape.frozen_at, A_FROZEN_AT, 'nor is A\'s freeze stamp')
    // What it is instead: B's own settings, still provably unchanged since B was written.
    assert.equal(frozen?.shape.after_narration_sec, 6015, 'the 6000 s still + 15 s fade of the settings')
    assert.equal(frozen?.shape.source, 'settings')
  })

  test('with the settings moved, a stale verdict leaves the sweep and the recheck saying unknown', async () => {
    const channel = await planlessChannel()
    await storeVerdictFor(channel.videoPath, A_VERDICT)
    // B is written, then the preset moves after it: nothing on disk can say what B was made to be.
    await replaceFinal(channel, { ageSec: 3600 })
    await pm.updateConfig(channel.slug, sproutConfig(introAsset, 0) as any)

    const sweep = await freezeExistingPlanlessFinals()
    assert.ok(sweep.unknown_finals.includes(channel.videoPath), 'reported, not frozen from A\'s verdict')
    assert.equal(await readFrozenShape(channel.videoPath), null, 'and nothing was written claiming a shape')

    const recheck = await planlessExpectationFor(await ref(channel))
    assert.equal(recheck.kind, 'unknown')
    if (recheck.kind !== 'unknown') return
    assert.match(recheck.reason, /settings changed after this video was rendered/)
  })

  test('a verdict that still describes the file is still the shape the sweep freezes onto it', async () => {
    // The other half of the rule: the stale test must not become a blanket waiver for old finals.
    const channel = await planlessChannel()
    await storeVerdictFor(channel.videoPath, A_VERDICT)
    assert.equal((await readStoredFinalCheck(channel.videoPath))?.stale, false,
      'this verdict measured exactly these bytes')

    const sweep = await freezeExistingPlanlessFinals()

    assert.ok(sweep.records.includes(channel.videoPath))
    const frozen = await readFrozenShape(channel.videoPath)
    assert.equal(frozen?.stale, false)
    assert.equal(frozen?.shape.after_narration_sec, A_TAIL_SEC, "the verdict's own recorded shape is the answer")
    assert.equal(frozen?.shape.intro?.asset, A_INTRO_ASSET)
    assert.equal(frozen?.shape.source, 'plan')
    assert.equal(frozen?.shape.frozen_at, A_FROZEN_AT)
  })
})

/**
 * The final's OWN RENDER REQUEST, and the shaping fingerprint (2026-10-20).
 *
 * `config.json` is project-wide: any save anywhere in the channel rewrites it, so "the settings file
 * has not been written since the final" is defeated for every final the channel has ever made. That
 * is not hypothetical — measured on the mini, thirteen of nineteen channels' files were rewritten
 * inside seven seconds by one campaign, long after their finals were rendered, and NOT ONE final in
 * the fleet had a freeze. The request a render was given does not depend on that file's mtime at
 * all: it is the instruction the render ran on, saved beside the run.
 */
describe("a final's own render request", () => {
  test('it freezes a final whose channel settings moved after it was rendered', async () => {
    // Rendered two hours ago; the channel's settings were saved after it. Without the request this is
    // `unknown` (the test above), and the owner's own final does not pass.
    const channel = await planlessChannel({ finalAgeSec: 7200 })
    const jobId = await saveRenderRequest(channel, {
      createdAt: new Date(Date.now() - 10800_000).toISOString(),
      finishedAt: new Date(Date.now() - 7100_000).toISOString(),
    })

    const settled = await planlessExpectationFor(await ref(channel))

    assert.equal(settled.kind, 'frozen', 'the render request answers for the file it made')
    if (settled.kind !== 'frozen') return
    assert.equal(settled.shape.source, 'job')
    assert.equal(settled.shape.after_narration_sec, 6015, '6000 s of still + a 15 s fade post-roll')
    assert.equal(settled.shape.intro?.asset, introAsset)
    assert.ok((settled.shape.intro?.black?.length ?? 0) > 0, 'the intro asset was measured, and its black frozen with it')
    assert.match(String(settled.shape.evidence), new RegExp(jobId), 'the record names the job it was taken from')
    assert.match(String(settled.shape.evidence), /saved request/)
    assert.ok(settled.shape.shaping_fingerprint, 'and which settings shaped it')
  })

  test("the shape is the request's, not the channel's settings as they are now", async () => {
    // The channel's settings still carry the 6000 s clip. The request that made this file did not —
    // and the request is what the file was made to be.
    const channel = await planlessChannel({ finalAgeSec: 7200 })
    await saveRenderRequest(channel, {
      createdAt: new Date(Date.now() - 10800_000).toISOString(),
      finishedAt: new Date(Date.now() - 7100_000).toISOString(),
      clipSec: 0,
    })

    const settled = await planlessExpectationFor(await ref(channel))

    assert.equal(settled.kind, 'frozen')
    if (settled.kind !== 'frozen') return
    assert.equal(settled.shape.after_narration_sec, 15, "the request's own 15 s post-roll, not today's 6000 s clip")
  })

  test('a request made after the final is not evidence about it', async () => {
    // The file on disk is from two hours ago; this request is from a minute ago, so it describes a
    // LATER render. Taking it would certify the file against a render it did not come from.
    const channel = await planlessChannel({ finalAgeSec: 7200 })
    await saveRenderRequest(channel, {
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 30_000).toISOString(),
    })

    const settled = await planlessExpectationFor(await ref(channel))

    assert.equal(settled.kind, 'unknown')
    assert.equal(await readFrozenShape(channel.videoPath), null)
  })

  test('a request that has not finished is about to replace the file, not the one that made it', async () => {
    const channel = await planlessChannel({ finalAgeSec: 7200 })
    await saveRenderRequest(channel, {
      createdAt: new Date(Date.now() - 10800_000).toISOString(),
      finishedAt: new Date(Date.now() - 7100_000).toISOString(),
      status: 'queued',
    })

    const settled = await planlessExpectationFor(await ref(channel))

    assert.equal(settled.kind, 'unknown')
    assert.equal(await readFrozenShape(channel.videoPath), null)
  })

  test('a request that finished before the final existed is an earlier render of it', async () => {
    // This render ended two hours ago; the file on disk is an hour old, so it is NOT the one this
    // request made. Binding the file to it would certify a shape for a render it did not come from.
    const channel = await planlessChannel({ finalAgeSec: 3600 })
    await saveRenderRequest(channel, {
      createdAt: new Date(Date.now() - 10800_000).toISOString(),
      finishedAt: new Date(Date.now() - 7200_000).toISOString(),
    })

    const settled = await planlessExpectationFor(await ref(channel))

    assert.equal(settled.kind, 'unknown')
    assert.equal(await readFrozenShape(channel.videoPath), null)
  })

  test("another episode's request is not this final's evidence", async () => {
    const channel = await planlessChannel({ finalAgeSec: 7200 })
    await saveRenderRequest(channel, {
      createdAt: new Date(Date.now() - 10800_000).toISOString(),
      finishedAt: new Date(Date.now() - 7100_000).toISOString(),
      episodeId: 'EP002',
    })

    const settled = await planlessExpectationFor(await ref(channel))

    assert.equal(settled.kind, 'unknown')
  })

  test('the newest request that predates the final is the one it was made by', async () => {
    const channel = await planlessChannel({ finalAgeSec: 14400 })
    const older = new Date(Date.now() - 16_000_000).toISOString()
    const newer = new Date(Date.now() - 15_000_000).toISOString()
    // Two renders of this episode are saved; only the later one is the file that is on disk.
    const first = await saveRenderRequest(channel, {
      createdAt: older, finishedAt: new Date(Date.now() - 14_300_000).toISOString(), clipSec: 6000,
    })
    const second = await saveRenderRequest(channel, {
      createdAt: newer, finishedAt: new Date(Date.now() - 14_350_000).toISOString(), clipSec: 1200,
    })
    assert.notEqual(first, second)
    const settled = await planlessExpectationFor(await ref(channel))

    assert.equal(settled.kind, 'frozen')
    if (settled.kind !== 'frozen') return
    assert.equal(settled.shape.after_narration_sec, 1215, 'the newer request, not the older one')
    assert.match(String(settled.shape.evidence), new RegExp(second))
  })
})

/**
 * The shaping fingerprint: a content fingerprint of ONLY the fields that shape the expectation.
 *
 * It is the narrow answer to the question the settings file's mtime answers far too broadly, and it
 * is recorded with every freeze so the record names which settings it was taken from.
 */
describe('the shaping fingerprint', () => {
  test('it moves when the fields that shape the expectation move, and not when others do', async () => {
    const withClip = shapingFingerprint(sproutConfig(introAsset, 6000))
    const withoutClip = shapingFingerprint(sproutConfig(introAsset, 0))
    assert.notEqual(withClip, withoutClip, 'the clip is one of the fields that shapes the expectation')
    assert.match(withClip, /^[a-f0-9]{64}$/)

    // The same shaping fields, with a save that changed something else entirely: the fingerprint of
    // the fields that produce a tail and an intro is unmoved.
    const unrelatedSave = { ...sproutConfig(introAsset, 6000), voice_presets: [{ name: 'someone else' }] }
    assert.equal(shapingFingerprint(unrelatedSave), withClip)

    const postRollMoved = sproutConfig(introAsset, 6000) as any
    postRollMoved.video_bundle_presets[0].data.fallback.timeline.post_audio = {
      behavior: 'hold-last-scene', fade_duration: 30, tail_seconds: 25,
    }
    assert.notEqual(shapingFingerprint(postRollMoved), withClip, 'the post-roll shapes the expectation too')
  })

  test('every freeze records the fingerprint of the settings it was taken from', async () => {
    const channel = await planlessChannel()
    const settled = await planlessExpectationFor(await ref(channel))
    assert.equal(settled.kind, 'frozen')
    if (settled.kind !== 'frozen') return
    assert.equal(settled.shape.shaping_fingerprint, shapingFingerprint(sproutConfig(introAsset, 6000)))
    assert.match(String(settled.shape.evidence), /settings/)
  })
})

/**
 * Reading a channel's freeze state — for a final that has never been checked (2026-10-20).
 *
 * `GET .../youtube/final-check` answers 404 before it looks beside the file, so a final nobody has
 * checked yet could not say whether its expectation was frozen before the channel's settings moved.
 * Production needs exactly that answer for every historical final of a channel, which is what this
 * read is for — and it must never take a freeze itself.
 */
describe("reading a channel's freeze state", () => {
  test('it reports a final whose evidence chain would answer, without freezing it', async () => {
    const channel = await planlessChannel()

    const states = await finalFreezeStates(channel.slug)
    const row = states.find(state => state.episode_code === 'EP001')

    assert.ok(row, 'the final on disk is listed')
    assert.equal(row.frozen, null, 'nothing is frozen yet — looking is not taking')
    assert.equal(row.unknown_reason, null, 'and the evidence chain has an answer for it')
    assert.equal(await readFrozenShape(channel.videoPath), null, 'no record was written beside the file')
  })

  test('it says which evidence is missing for a final that cannot be answered', async () => {
    const channel = await planlessChannel({ finalAgeSec: 3600 })

    const states = await finalFreezeStates(channel.slug)
    const row = states.find(state => state.episode_code === 'EP001')

    assert.ok(row)
    assert.equal(row.frozen, null)
    assert.match(String(row.unknown_reason), /settings changed after this video was rendered/)
    assert.equal(await readFrozenShape(channel.videoPath), null)
  })

  test('a final frozen from its render request reports what it was taken from', async () => {
    const channel = await planlessChannel({ finalAgeSec: 7200 })
    const jobId = await saveRenderRequest(channel, {
      createdAt: new Date(Date.now() - 10800_000).toISOString(),
      finishedAt: new Date(Date.now() - 7100_000).toISOString(),
    })
    assert.equal((await planlessExpectationFor(await ref(channel))).kind, 'frozen')

    const states = await finalFreezeStates(channel.slug)
    const row = states.find(state => state.episode_code === 'EP001')

    assert.ok(row?.frozen, 'the freeze beside the file is reported')
    assert.equal(row.frozen.source, 'job')
    assert.equal(row.frozen.after_narration_sec, 6015)
    assert.equal(row.frozen.stale, false)
    assert.match(String(row.frozen.evidence), new RegExp(jobId))
    assert.ok(row.frozen.shaping_fingerprint)
  })
})

/**
 * The owner's own recorded decision (2026-10-20), and the freeze it allows.
 *
 * SS0063's shape cannot be proved from anything on disk: its render request was pruned from the job
 * store, and the channel's `config.json` was rewritten by a fleet-wide campaign a day after the
 * final. The owner decided it anyway, twice — first that the already-made finals be retained
 * (turn `662f2e99`), then, asked how to write their expectation down when nothing proves which
 * settings made them, that it be taken from today's settings. This is that decision recorded as a
 * source of its own: scoped to the one channel and to finals made before it, confirmed against the
 * file's own length and opening before anything is written, and stamped with the words it rests on.
 */
describe("the owner's recorded decision", () => {
  /** Story Sprout itself, with one already-made final — the channel and finals the decision names. */
  let sprout: PlanlessChannel | null = null

  async function sproutChannel(opts: {
    /** The finished file's real length. */
    durationSec: number
    /** A black stretch in the file's own clock, when the test needs one. */
    black?: { from_sec: number; to_sec: number }
    /** When the final was written. Default: before the decision, like every already-made Sprout final. */
    mtimeIso?: string
    clipSec?: number
    chapters?: { gap_sec: number; durations_sec: number[] }
    /** The opening the episode's own Scene Plan reserved, which widens the intro's window. */
    openingReservedSec?: number
  }): Promise<PlanlessChannel> {
    if (!sprout) {
      const project = await pm.createProject({ name: 'Story Sprout', episode_prefix: 'SS', episode_digits: 4 })
      assert.equal(project.slug, 'story-sprout', 'the decision is scoped by this channel\'s own slug')
      const projectDir = pm.getProjectDir(project.slug)!
      await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
        ideas: [{
          id: 'i-1', title: 'A Day Volunteering at the Daycare', logline: 'l', themes: [],
          suggested_chapters: 1, suggested_length: '1 min', mood: 'm', status: 'accepted',
          episode_code: 'SS0063', generated_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z',
          batch_id: 'imported', model_used: 'imported',
        }],
        next_episode_number: 64, recycled_numbers: [],
      }))
      const paths = await resolveEpisodePathsByCode(project.slug, 'SS0063')
      sprout = {
        slug: project.slug, episodeDir: paths.episode_dir,
        videoPath: path.join(paths.video_dir, 'SS0063_final_video.mp4'),
        configPath: path.join(projectDir, 'config.json'),
      }
    }
    const channel = sprout
    // Each case starts from a final nobody has frozen yet: this channel's slug is what the decision
    // is scoped by, so the cases share the one project rather than one project each.
    await fs.rm(frozenExpectationPath(channel.videoPath), { force: true })
    await pm.updateConfig(channel.slug, sproutConfig(introAsset, opts.clipSec ?? 0) as any)
    await fs.mkdir(channel.episodeDir, { recursive: true })
    await fs.writeFile(path.join(channel.episodeDir, 'audio_chapters.json'), JSON.stringify({
      gap_duration_s: (opts.chapters ?? { gap_sec: 5 }).gap_sec,
      sections: (opts.chapters ?? { durations_sec: [2, 2] }).durations_sec.map(d => ({ duration_s: d })),
    }))
    await fs.mkdir(path.dirname(channel.videoPath), { recursive: true })
    const planPath = await resolveScenePlanPath(channel.slug, 'SS0063', channel.episodeDir)
    await fs.mkdir(path.dirname(planPath), { recursive: true })
    await fs.writeFile(planPath, JSON.stringify({
      opening_mode: 'branded-opening', opening_reserved_sec: opts.openingReservedSec ?? 0,
    }))
    const filter = `color=c=blue:s=320x180:r=5:d=${opts.durationSec}`
      + (opts.black ? `,drawbox=c=black:t=fill:enable='between(t,${opts.black.from_sec},${opts.black.to_sec})'` : '')
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', filter,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', channel.videoPath,
    ], { stdio: ['ignore', 'ignore', 'inherit'] })
    const when = new Date(opts.mtimeIso ?? '2026-10-18T04:48:37.697Z')
    await fs.utimes(channel.videoPath, when, when)
    return channel
  }

  /** The 24 s the sprout preset asks for: 9 s of chapters (2 + 5 + 2) plus a 15 s fade post-roll. */
  const matchingFinal = () => sproutChannel({ durationSec: 24, black: { from_sec: 0.5, to_sec: 3 } })

  test("an already-made Sprout final that matches the settings gets an owner freeze", async () => {
    const channel = await matchingFinal()

    const settled = await planlessExpectationFor(await ref(channel, 'SS0063'), { ownerAttestation: true })

    assert.equal(settled.kind, 'frozen')
    if (settled.kind !== 'frozen') return
    assert.equal(settled.shape.source, 'owner')
    assert.equal(settled.shape.after_narration_sec, 15, "today's settings: the 15 s fade post-roll")
    assert.equal(settled.shape.intro?.asset, introAsset)
    // The words it rests on are in the record, so it can never read as the app having proved it.
    assert.equal(settled.shape.owner?.turn_id, '662f2e99')
    assert.equal(settled.shape.owner?.decision_at, '2026-10-20T13:17:16.768Z')
    assert.equal(settled.shape.owner?.retain_quote, 'i want all already made videos to retain this')
    assert.equal(settled.shape.owner?.approve_quote, 'yes. this is the right approach and i approve of it. ship asap')
    assert.match(String(settled.shape.owner?.described_as), /taken from today's settings/)
    assert.match(String(settled.shape.evidence), /the owner's decision/)
    assert.ok(settled.shape.shaping_fingerprint)
    assert.deepEqual(settled.shape.intro?.window, { start_sec: 0, end_sec: 3 }, "the intro asset's own length")
    // The file it was taken for is the length and opening the shape describes.
    assert.deepEqual(
      finalCheckIssues(
        { ...SS0063_ACTUAL, duration_sec: 24, video_sec: 24, audio_sec: 24, silence: [] },
        planlessExpectation(expectationFromFrozenShape(settled.shape)),
      ),
      [],
    )
  })

  test("a final whose length is not the one its own settings ask for stays unknown", async () => {
    // 210 s against the 24 s its chapters and settings add up to: far past the check's own allowance,
    // so the settings are not what made this file and the owner's decision does not cover it.
    const channel = await sproutChannel({ durationSec: 210 })

    const settled = await planlessExpectationFor(await ref(channel, 'SS0063'), { ownerAttestation: true })

    assert.equal(settled.kind, 'unknown')
    if (settled.kind !== 'unknown') return
    assert.match(settled.reason, /the owner's decision of 2026-10-20/)
    assert.match(settled.reason, /210\.0s long/)
    assert.equal(await readFrozenShape(channel.videoPath), null, 'nothing was written')
  })

  test("black in the opening that the intro asset does not carry stays unknown", async () => {
    // Length is right, and the black IS inside the opening the episode reserved (12 s) — but the
    // intro asset is black only over 0.5–3 s of it, so this file is not the one the settings describe.
    const channel = await sproutChannel({
      durationSec: 24, black: { from_sec: 8, to_sec: 11 }, openingReservedSec: 12,
    })

    const settled = await planlessExpectationFor(await ref(channel, 'SS0063'), { ownerAttestation: true })

    assert.equal(settled.kind, 'unknown')
    if (settled.kind !== 'unknown') return
    assert.match(settled.reason, /is not black the intro asset carries/)
    assert.equal(await readFrozenShape(channel.videoPath), null)
  })

  test('a final made after the decision, and another channel, are both outside it', async () => {
    // Made after 2026-10-20T13:17:16.768Z: not an "already made video" when the owner decided.
    const after = await sproutChannel({ durationSec: 24, mtimeIso: '2026-10-20T14:00:00.000Z' })
    const lateSettled = await planlessExpectationFor(await ref(after, 'SS0063'), { ownerAttestation: true })
    assert.equal(lateSettled.kind, 'unknown')
    if (lateSettled.kind === 'unknown') {
      assert.doesNotMatch(lateSettled.reason, /the owner's decision of 2026-10-20/)
    }
    assert.equal(await readFrozenShape(after.videoPath), null)

    // And a channel the decision does not name is never attested for, whatever its file looks like.
    const other = await planlessChannel({ finalAgeSec: 3600 })
    const otherSettled = await planlessExpectationFor(await ref(other), { ownerAttestation: true })
    assert.equal(otherSettled.kind, 'unknown')
    assert.equal(await readFrozenShape(other.videoPath), null)
  })

  test('the boot sweep takes it, once, and the freeze survives the preset changing under it', async () => {
    const channel = await matchingFinal()

    const sweep = await freezeExistingPlanlessFinals()
    assert.ok(sweep.owner_attested >= 1, 'the sweep is what takes an owner freeze')
    const frozen = await readFrozenShape(channel.videoPath)
    assert.equal(frozen?.shape.source, 'owner')

    // Production then drops the 6000 s clip for future episodes; this file's expectation must not move.
    await pm.updateConfig(channel.slug, sproutConfig(introAsset, 6000) as any)
    const after = await planlessExpectationFor(await ref(channel, 'SS0063'), { ownerAttestation: true })
    assert.equal(after.kind, 'frozen')
    if (after.kind !== 'frozen') return
    assert.equal(after.shape.source, 'owner', 'the record it already has is the answer')
    assert.equal(after.shape.after_narration_sec, 15, 'and it is still the shape frozen from the settings then')

    // The channel's own read shows what it was taken on, for a person verifying without the app.
    const states = await finalFreezeStates(channel.slug)
    const row = states.find(state => state.episode_code === 'SS0063')
    assert.equal(row?.frozen?.source, 'owner')
    assert.equal(row?.frozen?.owner?.turn_id, '662f2e99')
    assert.match(String(row?.frozen?.evidence), /the owner's decision/)
  })
})

/**
 * The frozen tail's exact geometry (2026-10-21). A freeze that recorded where the closing tail sits
 * carries it through; a freeze written before the field existed is UNKNOWN, never a zero — and the
 * check says so instead of calling black near EOF "outside the closing tail" (AGENTS.md §6).
 */
describe('frozen closing-tail geometry', () => {
  const shape = (tail?: { sec: number; from_end_sec: number }): import('../lib/final-video-check.js').FrozenFinalCheckShape => ({
    schema_version: 1, frozen_at: A_FROZEN_AT, episode_code: 'EP001',
    file: { size: 1, mtime_ms: 1 }, source: 'plan', after_narration_sec: 600,
    ...(tail ? { tail } : {}), intro: null,
  })

  test('a known tail round trips, a recorded zero tail is an answer, and a pre-tail freeze is unknown', () => {
    const known = expectationFromFrozenShape(shape({ sec: 25, from_end_sec: 10 }))
    assert.deepEqual(known.tail, { sec: 25, from_end_sec: 10 })
    assert.equal(known.tail_unknown, false, 'a freeze that recorded the field answers explicitly')

    const none = expectationFromFrozenShape(shape({ sec: 0, from_end_sec: 0 }))
    assert.deepEqual(none.tail, { sec: 0, from_end_sec: 0 })
    assert.equal(none.tail_unknown, false, 'a zero the freeze recorded is a known answer, not unknown')

    const unknown = expectationFromFrozenShape(shape())
    assert.equal(unknown.tail_unknown, true)
    const issues = finalCheckIssues({
      duration_sec: 1000, video_sec: 1000, audio_sec: 1000, width: 128, height: 96, tail_lufs: null,
      black: [{ start_sec: 900, end_sec: 960 }], silence: [],
    }, planlessExpectation(unknown))
    const black = issues.find(issue => issue.check === 'black')
    assert.match(black?.verdict ?? '', /intended closing-tail placement could not be established/)
  })

  test("a verdict's recorded tail is frozen onto the file and read back; a verdict without one stays unknown", async () => {
    const channel = await planlessChannel()
    await storeVerdictFor(channel.videoPath, { ...A_VERDICT, tail: { sec: 30, from_end_sec: 15 } })
    await freezeExistingPlanlessFinals()
    const frozen = await readFrozenShape(channel.videoPath)
    assert.deepEqual(frozen?.shape.tail, { sec: 30, from_end_sec: 15 }, "the verdict's own tail, not a zero")
    assert.deepEqual(expectationFromFrozenShape(frozen!.shape).tail, { sec: 30, from_end_sec: 15 })

    const legacy = await planlessChannel()
    await storeVerdictFor(legacy.videoPath, { ...A_VERDICT, tail: undefined })
    await freezeExistingPlanlessFinals()
    const legacyFrozen = await readFrozenShape(legacy.videoPath)
    assert.equal(legacyFrozen?.shape.tail, undefined, 'a freeze taken without tail geometry records none')
    assert.equal(expectationFromFrozenShape(legacyFrozen!.shape).tail_unknown, true)
  })

  test("tail_unknown outranks a zero placeholder, and a verdict's bare zero is never a placement", async () => {
    // What the on-demand check writes when the freeze could not say where the tail sat: the seeded
    // zero placeholder, with `tail_unknown` beside it. The zero must not become the freeze's answer.
    const flattened = await planlessChannel()
    await storeVerdictFor(flattened.videoPath, {
      ...A_VERDICT, tail: { sec: 0, from_end_sec: 0 }, tail_unknown: true,
    })
    await freezeExistingPlanlessFinals()
    const flattenedFrozen = await readFrozenShape(flattened.videoPath)
    assert.equal(flattenedFrozen?.shape.tail, undefined, 'tail_unknown outranks the zero beside it')
    assert.equal(expectationFromFrozenShape(flattenedFrozen!.shape).tail_unknown, true)

    // A verdict written before `tail_unknown` existed carries the same flattened zero and no way to
    // say whether it meant "no tail" or "could not place it". History cannot answer the question, so
    // the freeze stays unknown rather than freezing a known-none (AGENTS.md §6).
    const bareZero = await planlessChannel()
    await storeVerdictFor(bareZero.videoPath, { ...A_VERDICT, tail: { sec: 0, from_end_sec: 0 } })
    await freezeExistingPlanlessFinals()
    const bareZeroFrozen = await readFrozenShape(bareZero.videoPath)
    assert.equal(bareZeroFrozen?.shape.tail, undefined, "a verdict's zero proves no placement")
    assert.equal(expectationFromFrozenShape(bareZeroFrozen!.shape).tail_unknown, true)

    // The current app writes the field as an explicit answer, including a freeze whose `tail` is
    // `null` ("this final drew no tail"). A deliberate known-none must survive the roundtrip; only
    // an unmarked zero is ambiguous.
    const explicitNone = await planlessChannel()
    await storeVerdictFor(explicitNone.videoPath, {
      ...A_VERDICT, tail: { sec: 0, from_end_sec: 0 }, tail_unknown: false,
    })
    await freezeExistingPlanlessFinals()
    const explicitNoneFrozen = await readFrozenShape(explicitNone.videoPath)
    assert.deepEqual(explicitNoneFrozen?.shape.tail, { sec: 0, from_end_sec: 0 },
      'an explicit known-none is not history: it survives')
    const explicitNoneExpectation = expectationFromFrozenShape(explicitNoneFrozen!.shape)
    assert.deepEqual(explicitNoneExpectation.tail, { sec: 0, from_end_sec: 0 })
    assert.equal(explicitNoneExpectation.tail_unknown, false)

    // A positive interval beside `tail_unknown` is still not a placement the verdict established.
    const contradictory = await planlessChannel()
    await storeVerdictFor(contradictory.videoPath, {
      ...A_VERDICT, tail: { sec: 30, from_end_sec: 15 }, tail_unknown: true,
    })
    await freezeExistingPlanlessFinals()
    const contradictoryFrozen = await readFrozenShape(contradictory.videoPath)
    assert.equal(contradictoryFrozen?.shape.tail, undefined, 'unknown outranks a tail field beside it')
    assert.equal(expectationFromFrozenShape(contradictoryFrozen!.shape).tail_unknown, true)
  })
})
