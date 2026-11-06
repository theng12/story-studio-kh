/**
 * 1.4.272 — a Scene Plan timed from narration at 0 s, rendered over merged audio
 * that opens with a music lead-in (Night Atlas: 8 s). Video Assembly used to
 * refuse it ("8.0s of narration has no planned scene"). Now scene 1 holds through
 * the intro and every later scene moves by the lead-in the merge recorded.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { scenePlanLeadInShiftSec, shiftScenesForLeadIn } from '../lib/intro-lead-in.js'

const SLUG = 'lead-in-shift'
let tmp: { dir: string; cleanup: () => Promise<void> }
let n = 0

before(async () => {
  tmp = await useTempDataDir()
  const projectDir = path.join(tmp.dir, 'projects', SLUG)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Lead-in Shift', episode_prefix: 'EP', season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [1, 2, 3, 4].map(i => ({ id: `idea-${i}`, title: `Ep ${i}`, status: 'accepted', episode_code: `EP000${i}` })),
    next_episode_number: 5, recycled_numbers: [],
  }))
})

after(async () => { await tmp.cleanup() })

type Span = [number, number]

/** One episode: approved plan scenes with images, and a merged track whose record states its lead-in. */
async function episode(spans: Span[], mergedSec: number, leadInSec: number) {
  const code = `EP000${++n}`
  const episodeDir = path.join(tmp.dir, 'projects', SLUG, 'episodes', 'Season 001', `${code} - Ep ${n}`)
  const imagesDir = path.join(episodeDir, 'scene_images')
  const mergedDir = path.join(episodeDir, `${code} - 08 Audio Merge Output`)
  await fs.mkdir(imagesDir, { recursive: true })
  await fs.mkdir(mergedDir, { recursive: true })
  const scenes = spans.map(([start_sec, end_sec], i) => ({
    id: `s${i + 1}`, scene_index: i + 1, start_sec, end_sec,
    transcript_segment: 'x', visual_prompt: 'x', approved: true,
  }))
  for (const scene of scenes) await fs.writeFile(path.join(imagesDir, `${scene.id}.png`), 'png')
  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1, generated_at: new Date().toISOString(), research_used: false, opening_mode: 'from-start',
    total_duration_sec: spans.at(-1)![1], scenes,
  }))
  const filename = `${code}_merged_audio.mp3`
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=${mergedSec}`,
    '-codec:a', 'libmp3lame', '-q:a', '9', path.join(mergedDir, filename),
  ])
  await fs.writeFile(path.join(mergedDir, `${code}_merged_audio.completion.json`), JSON.stringify({
    output_filename: filename, duration_sec: mergedSec,
    opening: { lead_in_sec: leadInSec, intro: null, music_lead_in_sec: leadInSec },
  }))
  const { scanEpisodeAssets } = await import('../generators/video.js')
  return scanEpisodeAssets(SLUG, code)
}

/** One episode whose plan has no measured narration at all (no merged track, zero plan duration). */
async function unmeasuredEpisode() {
  const code = `EP000${++n}`
  const episodeDir = path.join(tmp.dir, 'projects', SLUG, 'episodes', 'Season 001', `${code} - Ep ${n}`)
  const imagesDir = path.join(episodeDir, 'scene_images')
  await fs.mkdir(imagesDir, { recursive: true })
  const scenes = [{
    id: 's1', scene_index: 1, start_sec: 0, end_sec: 10,
    transcript_segment: 'x', visual_prompt: 'x', approved: true,
  }]
  await fs.writeFile(path.join(imagesDir, 's1.png'), 'png')
  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1, generated_at: new Date().toISOString(), research_used: false, opening_mode: 'from-start',
    total_duration_sec: 0, scenes,
  }))
  const { scanEpisodeAssets } = await import('../generators/video.js')
  return scanEpisodeAssets(SLUG, code)
}

const near = (actual: number | undefined, expected: number, tolerance = 0.15) =>
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `${actual} ≈ ${expected}`)

describe('Scene Plan on the merged audio clock (music lead-in)', () => {
  test('8 s lead-in: scene 1 covers 0–8 s plus its own span, the rest shift, assembly coverage passes', async () => {
    const assets = await episode([[0, 5], [5, 10], [10, 15]], 23, 8)
    const timing = assets.scene_plan_timing!
    assert.equal(timing.audio_lead_in_shift_sec, 8)
    assert.equal(timing.complete, true)
    assert.ok((timing.uncovered_sec ?? NaN) <= 0.2, `uncovered ${timing.uncovered_sec}`)
    assert.deepEqual(timing.scenes.map(s => [s.start_sec, s.end_sec]), [[0, 13], [13, 18], [18, 23]])
    assert.deepEqual(assets.scenes.map(s => s.duration_sec), [13, 5, 5])
    // Scene 1 keeps its start, so the opening offset (and with it the captions) does not move.
    const { narrationLeadInForOpening } = await import('../generators/video.js')
    assert.equal(narrationLeadInForOpening({ planStrict: true, sceneTimelineOffsetSec: 0 - timing.scenes[0]!.start_sec, introVideoInOpening: false }), 0)
  })

  test('no lead-in: the plan is unchanged and carries no shift', async () => {
    const assets = await episode([[0, 5], [5, 10], [10, 15]], 15, 0)
    const timing = assets.scene_plan_timing!
    assert.equal('audio_lead_in_shift_sec' in timing, false)
    assert.equal(timing.complete, true)
    assert.equal(timing.coverage_measured, true)
    assert.equal(timing.uncovered_sec, 0)
    assert.deepEqual(timing.scenes.map(s => [s.start_sec, s.end_sec]), [[0, 5], [5, 10], [10, 15]])
  })

  test('a plan already built on the lead-in is not shifted twice', async () => {
    const assets = await episode([[0, 13], [13, 18], [18, 23]], 23, 8)
    const timing = assets.scene_plan_timing!
    assert.equal('audio_lead_in_shift_sec' in timing, false)
    assert.deepEqual(timing.scenes.map(s => [s.start_sec, s.end_sec]), [[0, 13], [13, 18], [18, 23]])
  })

  test('a real gap in the middle still fails', async () => {
    const assets = await episode([[0, 5], [10, 15]], 23, 8)
    const timing = assets.scene_plan_timing!
    assert.equal(timing.audio_lead_in_shift_sec, 8)
    assert.equal(timing.complete, false)
    assert.equal(timing.coverage_measured, true)
    near(timing.uncovered_sec ?? NaN, 5)
    assert.equal(timing.gap_count, 1)
  })

  test('no measured narration keeps coverage unknown, never 0 s covered', async () => {
    const assets = await unmeasuredEpisode()
    const timing = assets.scene_plan_timing!
    assert.equal(timing.coverage_measured, false)
    assert.equal(timing.coverage_reason, 'missing-duration')
    assert.equal(timing.uncovered_sec, null)
    assert.equal(timing.head_gap_sec, null)
    assert.equal(timing.tail_gap_sec, null)
    assert.equal(timing.gap_count, null)
    assert.equal(timing.complete, false)
  })

  test('blockingUncoveredNarrationSeconds refuses unknown coverage instead of reading it as 0', async () => {
    const { blockingUncoveredNarrationSeconds } = await import('../generators/video.js')
    assert.throws(
      () => blockingUncoveredNarrationSeconds({ uncovered_sec: null, head_gap_sec: null }, {} as any),
      /coverage is unknown/i,
    )
  })

  test('the shift rule itself', () => {
    const plan = [{ start_sec: 0, end_sec: 5 }, { start_sec: 5, end_sec: 15 }]
    assert.equal(scenePlanLeadInShiftSec(plan, 7.99, 22.95), 7.99)
    assert.equal(scenePlanLeadInShiftSec(plan, 8, 15), 0, 'plan already ends with the audio')
    assert.equal(scenePlanLeadInShiftSec(plan, 8, 40), 0, 'a tail that is not the lead-in is left to the coverage check')
    assert.equal(scenePlanLeadInShiftSec(plan, null, 23), 0, 'unmeasured lead-in never shifts')
    assert.deepEqual(shiftScenesForLeadIn(plan, 8), [{ start_sec: 0, end_sec: 13 }, { start_sec: 13, end_sec: 23 }])
    assert.equal(shiftScenesForLeadIn(plan, 0), plan)
  })

  test('YouTube chapters already start after the lead-in', async () => {
    const { buildYouTubeChapters } = await import('../services/youtube-metadata-finalizer.js')
    const chapters = buildYouTubeChapters({
      sections: [{ slug: 'chapter_1', duration_sec: 60 }, { slug: 'chapter_2', duration_sec: 60 }],
      outline: [], gapSec: 1, leadInSec: 8,
    })
    assert.deepEqual(chapters.map(c => [c.start_sec]), [[0], [8], [69]])
  })

  test('resume: a shifted plan is a different render identity; an unshifted one is unchanged', async () => {
    const { buildVideoAssemblyRenderFingerprint } = await import('../lib/video-assembly-checkpoint.js')
    const plain = { opening_reserved_sec: 0, scenes: [{ id: 's1', start_sec: 0, end_sec: 5 }, { id: 's2', start_sec: 5, end_sec: 15 }] }
    const shifted = { ...plain, audio_lead_in_shift_sec: 8, scenes: shiftScenesForLeadIn(plain.scenes, 8) }
    const fp = (timing: unknown) => buildVideoAssemblyRenderFingerprint({ authoritative_scene_plan: timing })
    assert.equal(await fp(plain), await fp(structuredClone(plain)))
    assert.notEqual(await fp(shifted), await fp(plain))
  })
})
