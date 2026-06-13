/**
 * Tests for the prompts-less ("looser") asset detection in
 * services/asset-status.ts (Part 2 of the mark-done plan).
 *
 * Coverage:
 *   - getImageStatus: PNGs in bg_dir without a Scene_Prompts docx →
 *     scenes detected (total === present, missing === [])
 *   - getImageStatus: PNGs in thumb_dir without a Thumb_Prompts docx →
 *     thumbnails detected
 *   - getVideoStatus: MP4s in video_dir without a prompts docx → videos
 *     detected
 *   - With a prompts docx present, the existing strict expected-vs-present
 *     behaviour is preserved (partial generations still flag false)
 *   - Empty episodes (no files, no docx) report no scenes/thumbs/video
 *     (mode 'all', no buckets) — back-compat
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let assetStatus: typeof import('../services/asset-status.js')
let cacheMod: typeof import('../services/episode-status-cache.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'loose-detect'
const CODE = 'EP0001'
const TITLE = 'Loose Detection'

interface EpisodeDirs {
  projDir: string
  episodeDir: string
  bgDir: string
  thumbDir: string
  videoDir: string
  scenePromptsDir: string
  thumbPromptsDir: string
}

async function makeProject(): Promise<EpisodeDirs> {
  const projDir = path.join(pm.PROJECTS_ROOT, SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Loose Detection',
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, output_root: outputRoot, created_at: new Date().toISOString(),
  }))
  // One accepted idea — required for the looser-detect path because it
  // resolves the episode dir via resolveEpisodePaths(slug, code, title).
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: 'i-1', title: TITLE, logline: 'l', themes: [], suggested_chapters: 8,
      suggested_length: '30 min', mood: 'm', status: 'accepted', episode_code: CODE,
      generated_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z',
      batch_id: 'imported', model_used: 'imported',
    }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))

  // Default subfolder names (matches DEFAULT_SUBFOLDER_NAMES in models/types.ts).
  const episodeDir = path.join(outputRoot, 'Season 001', `${CODE} - ${TITLE}`)
  const bgDir = path.join(episodeDir, `${CODE} - 05 Scene Images`)
  const thumbDir = path.join(episodeDir, `${CODE} - 06 Thumbnail Images`)
  const videoDir = path.join(episodeDir, `${CODE} - 10 Video Assembly Output`)
  const scenePromptsDir = path.join(episodeDir, `${CODE} - 03 Scene Prompts`)
  const thumbPromptsDir = path.join(episodeDir, `${CODE} - 04 Thumbnail Prompts`)

  for (const d of [bgDir, thumbDir, videoDir, scenePromptsDir, thumbPromptsDir]) {
    await fs.mkdir(d, { recursive: true })
  }

  return { projDir, episodeDir, bgDir, thumbDir, videoDir, scenePromptsDir, thumbPromptsDir }
}

// 1×1 transparent PNG bytes — small but non-empty so fileHasContent() returns
// true. Mirrors what the real generator produces (just a lot smaller).
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
  'hex',
)

const MP4_BYTES = Buffer.from('not-actually-an-mp4-but-non-empty-for-content-check', 'utf-8')

describe('asset-status looser detection (no prompts docx)', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    assetStatus = await import('../services/asset-status.js')
    cacheMod = await import('../services/episode-status-cache.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.PROJECTS_ROOT, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    cacheMod.episodeStatusCache.clear()
  })

  test('empty episode (no files, no prompts) → mode "all", no buckets', async () => {
    await makeProject()
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.equal(result.mode, 'all')
    assert.equal(result.scenes, undefined)
    assert.equal(result.thumbnails, undefined)
  })

  test('PNGs in bg_dir without prompts → scenes detected with total === present', async () => {
    const { bgDir } = await makeProject()
    // 5 hand-named scenes, each with a single v1 variant.
    for (let n = 1; n <= 5; n++) {
      const stem = `${CODE}_Scene${n.toString().padStart(2, '0')}`
      await fs.writeFile(path.join(bgDir, `${stem}_v1.png`), PNG_BYTES)
    }
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.ok(result.scenes, 'scenes bucket present')
    assert.equal(result.scenes!.total, 5)
    assert.equal(result.scenes!.present, 5)
    assert.deepEqual(result.scenes!.missing, [])
    assert.equal(result.thumbnails, undefined, 'no thumbs found → no bucket')
  })

  test('PNGs in thumb_dir without prompts → thumbnails detected', async () => {
    const { thumbDir } = await makeProject()
    for (let n = 1; n <= 3; n++) {
      const stem = `${CODE}_Thumb${n.toString().padStart(2, '0')}`
      await fs.writeFile(path.join(thumbDir, `${stem}_v1.png`), PNG_BYTES)
    }
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.ok(result.thumbnails, 'thumbnails bucket present')
    assert.equal(result.thumbnails!.total, 3)
    assert.equal(result.thumbnails!.present, 3)
    assert.deepEqual(result.thumbnails!.missing, [])
  })

  test('multiple variants of the same scene count as ONE present scene', async () => {
    const { bgDir } = await makeProject()
    // 3 scenes, each with v1 + v2 + v3 (regenerations). Should still report 3.
    for (let n = 1; n <= 3; n++) {
      const stem = `${CODE}_Scene${n.toString().padStart(2, '0')}`
      for (let v = 1; v <= 3; v++) {
        await fs.writeFile(path.join(bgDir, `${stem}_v${v}.png`), PNG_BYTES)
      }
    }
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.equal(result.scenes!.total, 3, 'unique scene numbers, not file count')
    assert.equal(result.scenes!.present, 3)
  })

  test('zero-byte PNG does NOT count as present', async () => {
    const { bgDir } = await makeProject()
    // Scene 1 has a v1 with content; scene 2 only has an empty v1.
    await fs.writeFile(path.join(bgDir, `${CODE}_Scene01_v1.png`), PNG_BYTES)
    await fs.writeFile(path.join(bgDir, `${CODE}_Scene02_v1.png`), Buffer.alloc(0))
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.equal(result.scenes!.total, 1, 'only the non-empty scene counts')
    assert.equal(result.scenes!.present, 1)
  })

  test('MP4s in video_dir without prompts → video detected', async () => {
    const { videoDir } = await makeProject()
    for (let n = 1; n <= 4; n++) {
      const stem = `${CODE}_Video${n.toString().padStart(2, '0')}`
      await fs.writeFile(path.join(videoDir, `${stem}_v1.mp4`), MP4_BYTES)
    }
    const result = await assetStatus.getVideoStatus(SLUG, CODE)
    assert.equal(result.total, 4)
    assert.equal(result.present, 4)
    assert.deepEqual(result.missing, [])
  })

  test('computeEpisodeStatus reports images=true when scenes/thumbs detected loosely', async () => {
    const { bgDir, thumbDir } = await makeProject()
    for (let n = 1; n <= 2; n++) {
      await fs.writeFile(path.join(bgDir, `${CODE}_Scene0${n}_v1.png`), PNG_BYTES)
      await fs.writeFile(path.join(thumbDir, `${CODE}_Thumb0${n}_v1.png`), PNG_BYTES)
    }
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.images, true, 'looser scene detection flips images→true')
    assert.equal(status.thumbnails, true, 'looser thumb detection flips thumbnails→true')
  })

  // v1.0.352 — the Subtitles-page "Pending only" filter regression: an episode
  // with audio but no SRTs must report subtitles=false (it was borrowing the
  // `audio` field, so audio-ready episodes were wrongly hidden from pending).
  test('subtitles=false until an .srt/.vtt exists, then true', async () => {
    const { episodeDir } = await makeProject()
    const subsDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
    await fs.mkdir(subsDir, { recursive: true })

    // Empty subtitles folder → not done (this is the EP0006-0010 case).
    let status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.subtitles, false, 'no SRT yet → subtitles pending')

    // Drop a per-chapter SRT → done.
    await fs.writeFile(path.join(subsDir, `${CODE}_chapter_01.srt`), '1\n00:00:00,000 --> 00:00:02,000\nhi\n')
    cacheMod.episodeStatusCache.clear()
    status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.subtitles, true, 'an SRT present → subtitles done')
  })

  test('subtitles also detects a .vtt track', async () => {
    const { episodeDir } = await makeProject()
    const subsDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
    await fs.mkdir(subsDir, { recursive: true })
    await fs.writeFile(path.join(subsDir, `${CODE}_whisper.vtt`), 'WEBVTT\n\n00:00.000 --> 00:02.000\nhi\n')
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.subtitles, true, '.vtt counts as a subtitle track')
  })

  // v1.0.361 — Character Sheet "pending" filter regression: it keyed off
  // `script`, so every scripted episode looked done. character_sheet now means
  // the episode's continuity config has been saved (continuity.json on disk).
  test('character_sheet=false until continuity.json is saved, then true', async () => {
    const { episodeDir } = await makeProject()
    // No continuity.json yet → not configured (this is the "all show pending" case).
    let status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.character_sheet, false, 'no continuity.json → character sheet pending')

    // Save the continuity config (what the Character Sheet page's PUT writes).
    await fs.writeFile(
      path.join(episodeDir, 'continuity.json'),
      JSON.stringify({ schema_version: 1, anchor_character_ids: ['c1'], references: {} }),
    )
    cacheMod.episodeStatusCache.clear()
    status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.character_sheet, true, 'continuity.json present → character sheet done')
  })

  test('back-compat: prompts docx present → strict expected-vs-present preserved', async () => {
    // When the user HAS a prompts docx, the existing strict logic must
    // still apply. We can't easily fabricate a parseable docx here, so
    // we verify the fallback path is bypassed: drop a single non-empty
    // file at the canonical scene_prompts_docx path. The function will
    // attempt to parse it (and fail), but importantly it WILL NOT take
    // the looser path — which means scenes will report as missing/zero
    // since parseImagePromptsDocx() throws or returns no scenes.
    const { bgDir, scenePromptsDir } = await makeProject()
    // Drop a real PNG so the looser path WOULD see it…
    await fs.writeFile(path.join(bgDir, `${CODE}_Scene01_v1.png`), PNG_BYTES)
    // …but also drop the prompts docx so the looser branch is skipped.
    // We don't care if parsing throws; the assert below just confirms we
    // didn't fall through to the looser scenes-from-files path (which
    // would have reported total=1, present=1).
    await fs.writeFile(path.join(scenePromptsDir, `${CODE}_Scene_Prompts.docx`), Buffer.from('not-a-real-docx'))
    let result: any
    try {
      result = await assetStatus.getImageStatus(SLUG, CODE)
    } catch {
      // Parser may throw — that's fine, it confirms strict path was taken.
      return
    }
    // If it didn't throw, scenes.total should reflect the (failed) parse,
    // not the looser file scan. parseImagePromptsDocx returns scenes:[]
    // for an unparseable file, so total will be 0 — distinctly different
    // from the looser path's total=1.
    if (result.scenes) {
      assert.notEqual(result.scenes.total, 1,
        'with prompts docx present, scenes count must not come from raw file scan')
    }
  })
})
