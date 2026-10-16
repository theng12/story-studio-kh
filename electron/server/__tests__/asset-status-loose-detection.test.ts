/**
 * Tests for authoritative asset completion in services/asset-status.ts.
 *
 * Coverage:
 *   - Files without prompts do not invent their own expected totals.
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
import request from 'supertest'
import { writePromptCompletionManifest } from '../services/prompt-completion.js'

let pm: typeof import('../services/project-manager.js')
let assetStatus: typeof import('../services/asset-status.js')
let cacheMod: typeof import('../services/episode-status-cache.js')
let stitcher: typeof import('../services/subtitle-stitcher.js')
let app: any
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
  const projDir = path.join(pm.projectsRoot(), SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Loose Detection',
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, created_at: new Date().toISOString(),
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

describe('asset-status verified completion', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    assetStatus = await import('../services/asset-status.js')
    cacheMod = await import('../services/episode-status-cache.js')
    stitcher = await import('../services/subtitle-stitcher.js')
    app = (await import('../app.js')).app
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    cacheMod.episodeStatusCache.clear()
  })

  test('no manifest: a stray file does not mark Thumbnail Prompts or the Finalizer done; real output does', async () => {
    const { episodeDir, thumbPromptsDir } = await makeProject()
    const metadataDir = path.join(episodeDir, `${CODE} - 02 Metadata`)
    await fs.mkdir(metadataDir, { recursive: true })
    await fs.writeFile(path.join(thumbPromptsDir, 'notes.md'), 'just some notes\n')
    await fs.writeFile(path.join(metadataDir, 'scratch.json'), '{}')
    await fs.writeFile(path.join(metadataDir, `${CODE}_Metadata.txt`), '   \n')
    let status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.thumb_prompts, false, 'a file with no thumbnail prompt is not done')
    assert.equal(status.metadata, false, 'an empty package is not done')

    await fs.writeFile(path.join(thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`),
      '# Thumbnail Prompts\n\n1. Moonlit lake\nA quiet lake under the moon.\n')
    await fs.writeFile(path.join(metadataDir, `${CODE}_Metadata.json`),
      JSON.stringify({ title_options: ['A title'], description: 'A real description.', tags: [] }))
    status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.thumb_prompts, true, 'a legacy prompt document with a real prompt counts')
    assert.equal(status.metadata, true, 'a legacy package with a description counts')
  })

  test('empty episode (no files, no prompts) → mode "all", no buckets', async () => {
    await makeProject()
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.equal(result.mode, 'all')
    assert.equal(result.scenes, undefined)
    assert.equal(result.thumbnails, undefined)
  })

  test('PNGs in bg_dir without prompts do not mark scenes complete', async () => {
    const { bgDir } = await makeProject()
    // 5 hand-named scenes, each with a single v1 variant.
    for (let n = 1; n <= 5; n++) {
      const stem = `${CODE}_Scene${n.toString().padStart(2, '0')}`
      await fs.writeFile(path.join(bgDir, `${stem}_v1.png`), PNG_BYTES)
    }
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.equal(result.scenes, undefined, 'files cannot define their own expected total')
    assert.equal(result.thumbnails, undefined, 'no thumbs found → no bucket')
  })

  test('PNGs in thumb_dir without prompts do not mark thumbnails complete', async () => {
    const { thumbDir } = await makeProject()
    for (let n = 1; n <= 3; n++) {
      const stem = `${CODE}_Thumb${n.toString().padStart(2, '0')}`
      await fs.writeFile(path.join(thumbDir, `${stem}_v1.png`), PNG_BYTES)
    }
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.equal(result.thumbnails, undefined, 'files cannot define their own expected total')
  })

  test('multiple unmanifested variants still do not establish completion', async () => {
    const { bgDir } = await makeProject()
    // 3 scenes, each with v1 + v2 + v3 (regenerations). Should still report 3.
    for (let n = 1; n <= 3; n++) {
      const stem = `${CODE}_Scene${n.toString().padStart(2, '0')}`
      for (let v = 1; v <= 3; v++) {
        await fs.writeFile(path.join(bgDir, `${stem}_v${v}.png`), PNG_BYTES)
      }
    }
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.equal(result.scenes, undefined)
  })

  test('mixed valid and zero-byte unmanifested PNGs remain pending', async () => {
    const { bgDir } = await makeProject()
    // Scene 1 has a v1 with content; scene 2 only has an empty v1.
    await fs.writeFile(path.join(bgDir, `${CODE}_Scene01_v1.png`), PNG_BYTES)
    await fs.writeFile(path.join(bgDir, `${CODE}_Scene02_v1.png`), Buffer.alloc(0))
    const result = await assetStatus.getImageStatus(SLUG, CODE)
    assert.equal(result.scenes, undefined)
  })

  test('MP4s in video_dir without prompts do not mark video generation complete', async () => {
    const { videoDir } = await makeProject()
    for (let n = 1; n <= 4; n++) {
      const stem = `${CODE}_Video${n.toString().padStart(2, '0')}`
      await fs.writeFile(path.join(videoDir, `${stem}_v1.mp4`), MP4_BYTES)
    }
    const result = await assetStatus.getVideoStatus(SLUG, CODE)
    assert.equal(result.total, 0)
    assert.equal(result.present, 0)
    assert.deepEqual(result.missing, [])
  })

  test('computeEpisodeStatus keeps unmanifested scenes and thumbnails pending', async () => {
    const { bgDir, thumbDir } = await makeProject()
    for (let n = 1; n <= 2; n++) {
      await fs.writeFile(path.join(bgDir, `${CODE}_Scene0${n}_v1.png`), PNG_BYTES)
      await fs.writeFile(path.join(thumbDir, `${CODE}_Thumb0${n}_v1.png`), PNG_BYTES)
    }
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.images, false)
    assert.equal(status.thumbnails, false)
  })

  test('a corrupt introduction marker cannot mark the introduction complete', async () => {
    const { episodeDir } = await makeProject()
    const scriptDir = path.join(episodeDir, `${CODE} - 01 Script`)
    await fs.mkdir(scriptDir, { recursive: true })
    await fs.writeFile(path.join(scriptDir, `${CODE}_Script_Narration.intro.json`), '{}')

    let status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.introduction, false)

    await fs.writeFile(path.join(scriptDir, `${CODE}_Script_Narration.intro.json`), JSON.stringify({ word_count: 120 }))
    cacheMod.episodeStatusCache.clear()
    status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.introduction, true)
  })

  test('an authoritative partial prompt run cannot be promoted by the legacy scanner', async () => {
    const { scenePromptsDir } = await makeProject()
    await fs.writeFile(path.join(scenePromptsDir, `${CODE}_Scene_Prompts.md`), [
      '# Scene Prompts', '',
      '## Scene 1: One', '', 'first prompt', '',
      '## Scene 2: Two', '', 'second prompt', '',
    ].join('\n'))
    await writePromptCompletionManifest(scenePromptsDir, CODE, 'scene', 3)

    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.scene_prompts, false, '2/3 prompts must remain pending')
  })

  test('image completion preserves the original expected prompt count', async () => {
    const { scenePromptsDir, bgDir } = await makeProject()
    await fs.writeFile(path.join(scenePromptsDir, `${CODE}_Scene_Prompts.md`), [
      '# Scene Prompts', '',
      '## Scene 1: One', '', 'first prompt', '',
      '## Scene 2: Two', '', 'second prompt', '',
    ].join('\n'))
    await writePromptCompletionManifest(scenePromptsDir, CODE, 'scene', 3)
    await fs.writeFile(path.join(bgDir, `${CODE}_Scene01_v1.png`), PNG_BYTES)
    await fs.writeFile(path.join(bgDir, `${CODE}_Scene02_v1.png`), PNG_BYTES)

    const images = await assetStatus.getImageStatus(SLUG, CODE)
    assert.deepEqual(images.scenes, { total: 3, present: 2, missing: [3] })
  })

  test('subtitles remain pending until every audio section has an SRT', async () => {
    const { episodeDir } = await makeProject()
    const subsDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
    await fs.mkdir(subsDir, { recursive: true })
    await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
      gap_duration_s: 0,
      sections: [
        { slug: 'Introduction', duration_s: 2 },
        { slug: 'Chapter_01', duration_s: 2 },
        { slug: 'Chapter_02', duration_s: 2 },
      ],
    }))

    let status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.subtitles, false, 'no SRT yet → subtitles pending')

    await fs.writeFile(path.join(subsDir, `${CODE}_Introduction.srt`), '1\n00:00:00,000 --> 00:00:02,000\nintro\n')
    await fs.writeFile(path.join(subsDir, `${CODE}_Chapter_01.srt`), '1\n00:00:00,000 --> 00:00:02,000\none\n')
    cacheMod.episodeStatusCache.clear()
    status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.subtitles, false, 'one missing chapter → subtitles pending')

    await fs.writeFile(path.join(subsDir, `${CODE}_Chapter_02.srt`), '1\n00:00:00,000 --> 00:00:02,000\ntwo\n')
    cacheMod.episodeStatusCache.clear()
    status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.subtitles, false, 'complete chapter sources still need their derived timeline')

    await stitcher.stitchSubtitles({ episode_dir: episodeDir, subtitles_dir: subsDir, episode_code: CODE })
    cacheMod.episodeStatusCache.clear()
    status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.subtitles, true, 'a verified stitch over every expected section completes subtitles')
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

  // v1.0.362 — B-Roll "pending" filter regression: it keyed off `video` (AI
  // clips), which the stock-footage flow never produces, so every episode
  // looked pending forever. broll_picked now means a B-Roll selection has been
  // saved (broll-selection.json on disk, written by the /broll/pick route).
  test('broll_picked=false until broll-selection.json is saved, then true', async () => {
    const { episodeDir } = await makeProject()
    // No broll-selection.json yet → no clips picked.
    let status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.broll_picked, false, 'no broll-selection.json → B-Roll pending')

    // Save the picked selection (what the B-Roll page's pick route writes).
    await fs.writeFile(
      path.join(episodeDir, 'broll-selection.json'),
      JSON.stringify({ schema_version: 1, selection: [{ scene: 1, asset_id: 'a1' }] }),
    )
    cacheMod.episodeStatusCache.clear()
    status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.broll_picked, true, 'broll-selection.json present → B-Roll picked')
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

  // ── One thumbnail completion rule for every surface ──────────────────────
  const THUMB_MD = '# Thumbnail Prompts\n\n1. One\nfirst\n\n2. Two\nsecond\n\n3. Three\nthird\n\n4. Four\nfourth\n'

  async function writeThumbs(thumbDir: string, count: number) {
    for (let n = 1; n <= count; n++) {
      await fs.writeFile(path.join(thumbDir, `${CODE}_Thumb0${n}_v1.png`), PNG_BYTES)
    }
  }

  async function expectNotDone(episodeCode: string, total: number, present: number) {
    cacheMod.episodeStatusCache.clear()
    const status = await assetStatus.computeEpisodeStatus(SLUG, episodeCode)
    assert.equal(status.thumbnails, false, 'a partial thumbnail set is never done')
    assert.equal(status._thumbnail_images?.complete, false)
    assert.deepEqual([status._thumbnail_images?.total, status._thumbnail_images?.present], [total, present])
    const route = await assetStatus.getImageStatus(SLUG, episodeCode, 'thumbnails',
      await (await import('../services/utils.js')).resolveEpisodePathsByCode(SLUG, episodeCode))
    assert.equal(route.thumbnails?.total, total)
    const audit = await assetStatus.auditProjectAssets(SLUG)
    const row = audit.find(e => e.episode_id === episodeCode)
    assert.deepEqual([row?.thumbnails.total, row?.thumbnails.present], [total, present])
    const { isStepAlreadyDone } = await import('../routes/pipeline.js')
    assert.equal(isStepAlreadyDone(status, 'thumb_images'), false, 'repair_missing must not skip the step')
  }

  test('canonical folder: manifest expects 5, 4 thumbnails on disk -> not done on every surface', async () => {
    const { thumbPromptsDir, thumbDir } = await makeProject()
    await fs.writeFile(path.join(thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    await writePromptCompletionManifest(thumbPromptsDir, CODE, 'thumbnail', 5)
    await writeThumbs(thumbDir, 4)
    await expectNotDone(CODE, 5, 4)
  })

  test('canonical folder complete (5 of 5) is still done', async () => {
    const { thumbPromptsDir, thumbDir } = await makeProject()
    await fs.writeFile(path.join(thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    await writePromptCompletionManifest(thumbPromptsDir, CODE, 'thumbnail', 5)
    await writeThumbs(thumbDir, 5)
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.thumbnails, true)
    assert.equal(status._thumbnail_images?.complete, true)
  })

  test('music episode with 4 of 5 thumbnails is not rescued by the one-picture fallback', async () => {
    const { episodeDir, thumbPromptsDir, thumbDir } = await makeProject()
    await fs.writeFile(path.join(episodeDir, 'music_episode.json'), '{}')
    await fs.writeFile(path.join(thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    await writePromptCompletionManifest(thumbPromptsDir, CODE, 'thumbnail', 5)
    await writeThumbs(thumbDir, 4)
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.notEqual(status.music_episode, undefined, 'fixture is a music episode')
    assert.equal(status.thumbnails, false)
  })

  test('music episode with no prompt list still counts one picture as a thumbnail', async () => {
    const { episodeDir, thumbDir } = await makeProject()
    await fs.writeFile(path.join(episodeDir, 'music_episode.json'), '{}')
    await writeThumbs(thumbDir, 1)
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.thumbnails, true)
  })

  // The folder the generator searches first is found by name order; two duplicates either side of the canonical
  // folder (Aaa before it, Zzz after it) mean one of them is searched first in forward or reverse order alike.
  async function writeDuplicate(name: string, opts: { prompts: string | null; expected?: number; thumbs?: number }) {
    const { episodeDir } = await ensureProject()
    const dup = path.join(path.dirname(episodeDir), `${CODE} - ${name}`)
    const prompts = path.join(dup, `${CODE} - 04 Thumbnail Prompts`)
    const thumbs = path.join(dup, `${CODE} - 06 Thumbnail Images`)
    await fs.mkdir(prompts, { recursive: true })
    if (opts.prompts !== null) await fs.writeFile(path.join(prompts, `${CODE}_Thumbnail_Prompts.md`), opts.prompts)
    if (opts.expected) await writePromptCompletionManifest(prompts, CODE, 'thumbnail', opts.expected)
    if (opts.thumbs !== undefined) {
      await fs.mkdir(thumbs, { recursive: true })
      await writeThumbs(thumbs, opts.thumbs)
    }
    return dup
  }
  let currentProject: EpisodeDirs
  async function ensureProject() { return currentProject }
  async function completeCanonical() {
    currentProject = await makeProject()
    await fs.writeFile(path.join(currentProject.thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    await writePromptCompletionManifest(currentProject.thumbPromptsDir, CODE, 'thumbnail', 5)
    await writeThumbs(currentProject.thumbDir, 5)
  }

  test('complete canonical folder + incomplete duplicates -> done, no repair job', async () => {
    await completeCanonical()
    await writeDuplicate('Aaa Old Title', { prompts: THUMB_MD, expected: 5, thumbs: 4 })
    await writeDuplicate('Zzz Old Title', { prompts: THUMB_MD, expected: 5 })
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.thumbnails, true)
    assert.deepEqual([status._thumbnail_images?.total, status._thumbnail_images?.present], [5, 5])
    const { isStepAlreadyDone } = await import('../routes/pipeline.js')
    assert.equal(isStepAlreadyDone(status, 'thumb_images'), true, 'repair_missing skips a finished canonical folder')
  })

  test('incomplete canonical folder + complete duplicates sorting either side -> the generator and repair resolve the canonical folder', async () => {
    currentProject = await makeProject()
    await fs.writeFile(path.join(currentProject.thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    await writePromptCompletionManifest(currentProject.thumbPromptsDir, CODE, 'thumbnail', 5)
    await writeThumbs(currentProject.thumbDir, 4)
    await writeDuplicate('Aaa Old Title', { prompts: THUMB_MD, expected: 5, thumbs: 5 })
    await writeDuplicate('Zzz Old Title', { prompts: THUMB_MD, expected: 5, thumbs: 5 })
    const canonical = path.join(currentProject.thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`)
    const { findThumbPromptsFile, resolveImageDirs } = await import('../generators/images.js')
    assert.equal(await findThumbPromptsFile(SLUG, CODE), canonical, 'the generator writes into the canonical folder')
    assert.equal((await resolveImageDirs(SLUG, canonical, CODE)).thumbDir, currentProject.thumbDir)
    await expectNotDone(CODE, 5, 4)
  })

  test('a duplicate whose prompts list nothing cannot hold a finished episode open', async () => {
    await completeCanonical()
    await writeDuplicate('Aaa Old Title', { prompts: '# Thumbnail Prompts\n\nnothing usable here\n' })
    await writeDuplicate('Zzz Old Title', { prompts: '# Thumbnail Prompts\n\nnothing usable here\n' })
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.thumbnails, true)
  })

  test('a pinned scene picture completes a music episode whose prompt list is incomplete; a missing pin does not', async () => {
    const { episodeDir, thumbPromptsDir, thumbDir } = await makeProject()
    await fs.writeFile(path.join(episodeDir, 'music_episode.json'), '{}')
    await fs.writeFile(path.join(thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    await writePromptCompletionManifest(thumbPromptsDir, CODE, 'thumbnail', 5)
    await writeThumbs(thumbDir, 4)
    const { writeSelectedThumbnail } = await import('../services/upload-overrides.js')
    const pin = `${CODE}_Thumb_Scene03_v1.png`
    await writeSelectedThumbnail(SLUG, CODE, TITLE, 'youtube', pin)
    cacheMod.episodeStatusCache.clear()
    assert.equal((await assetStatus.computeEpisodeStatus(SLUG, CODE)).thumbnails, false, 'the pin names a file that is not there')
    await fs.writeFile(path.join(thumbDir, pin), PNG_BYTES)
    cacheMod.episodeStatusCache.clear()
    assert.equal((await assetStatus.computeEpisodeStatus(SLUG, CODE)).thumbnails, true, 'the owner replaced the thumbnails with this picture')
  })

  test('the episode status cache schema is bumped so persisted thumbnails=true rows are recomputed', () => {
    assert.ok(cacheMod.SCHEMA_VERSION >= 19)
  })

  test('image-status route: case-insensitive code, canonical folder, then the generator search for a renamed folder', async () => {
    const { episodeDir, thumbPromptsDir, thumbDir } = await makeProject()
    await fs.writeFile(path.join(thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    await writePromptCompletionManifest(thumbPromptsDir, CODE, 'thumbnail', 5)
    await writeThumbs(thumbDir, 4)
    let res = await request(app).get(`/api/projects/${SLUG}/episodes/${CODE.toLowerCase()}/image-status`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual([res.body.thumbnails.total, res.body.thumbnails.present], [5, 4])

    // The owner renamed the episode folder: the idea title no longer finds it, the search still does.
    const renamed = path.join(path.dirname(episodeDir), `${CODE} - Renamed By Owner`)
    await fs.rename(episodeDir, renamed)
    res = await request(app).get(`/api/projects/${SLUG}/episodes/${CODE}/image-status`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual([res.body.thumbnails?.total, res.body.thumbnails?.present], [5, 4])
  })

  test('image-status keeps working when the thumbnail images folder carries a "✅ " prefix', async () => {
    const { thumbPromptsDir, thumbDir } = await makeProject()
    await fs.writeFile(path.join(thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    await writePromptCompletionManifest(thumbPromptsDir, CODE, 'thumbnail', 5)
    await writeThumbs(thumbDir, 4)
    const prefixed = path.join(path.dirname(thumbDir), `✅ ${path.basename(thumbDir)}`)
    await fs.rename(thumbDir, prefixed)
    const res = await request(app).get(`/api/projects/${SLUG}/episodes/${CODE}/image-status`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual([res.body.thumbnails?.total, res.body.thumbnails?.present], [5, 4])
  })

  test('an episode with no folder yet does no whole-tree prompts search in status, only the single-episode route does', async () => {
    const { projDir, episodeDir } = await makeProject()
    await fs.mkdir(path.join(projDir, 'stash'), { recursive: true })
    await fs.rename(episodeDir, path.join(projDir, 'stash', 'old'))
    const stray = path.join(projDir, 'episodes', 'Season 001', 'Stray Folder')
    await fs.mkdir(stray, { recursive: true })
    await fs.writeFile(path.join(stray, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    cacheMod.episodeStatusCache.clear()
    const status = await assetStatus.computeEpisodeStatus(SLUG, CODE)
    assert.equal(status.thumbnails, false)
    assert.equal(status._thumbnail_images, undefined, 'status must not have walked the output tree to find the stray file')
    const res = await request(app).get(`/api/projects/${SLUG}/episodes/${CODE}/image-status`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.thumbnails?.total, 4, 'the single-episode route keeps the full search')
  })

  test('a pinned drawn thumbnail does not complete a 4 of 5 music episode; only scene pictures count', async () => {
    const { episodeDir, thumbPromptsDir, thumbDir } = await makeProject()
    await fs.writeFile(path.join(episodeDir, 'music_episode.json'), '{}')
    await fs.writeFile(path.join(thumbPromptsDir, `${CODE}_Thumbnail_Prompts.md`), THUMB_MD)
    await writePromptCompletionManifest(thumbPromptsDir, CODE, 'thumbnail', 5)
    await writeThumbs(thumbDir, 4)
    const { writeSelectedThumbnail } = await import('../services/upload-overrides.js')
    await writeSelectedThumbnail(SLUG, CODE, TITLE, 'youtube', `${CODE}_Thumb01_v1.png`)
    cacheMod.episodeStatusCache.clear()
    assert.equal((await assetStatus.computeEpisodeStatus(SLUG, CODE)).thumbnails, false)
  })
})
