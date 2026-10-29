/**
 * 1.4.368 — a translated episode's Scene Plan is retimed onto its OWN narration before Video
 * Assembly renders anything. That retime is a repair, not a guarantee: if the saved plan is still
 * stamped against a different narration after it, the render must REFUSE and name the scenes, not
 * let the pictures drift under the target voice (§8; the same rule as the general stale-plan check).
 *
 * Until this file, that refusal existed in `generators/video.ts` with no test executing it — the
 * retime normally clears the stamp, so only a damage/older-write shape reaches the branch, and
 * nothing built that shape. These tests drive the REAL `prepareUnifiedVideoAssemblyInputs`:
 *
 *   - a stale translated plan → loud refusal naming the scenes, and no video written;
 *   - a plan retimed onto this narration → the check passes and preparation goes on;
 *   - an Image Pool render → the Scene Plan is not played, so it is never refused for its timings.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import * as pm from '../services/project-manager.js'
import * as ideas from '../services/idea-manager.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { TRANSLATION_SIDECAR } from '../services/translation.js'

const CODE = 'KH0001'
const MERGED_NAME = `${CODE}_merged_audio.mp3`
/** The target (Khmer) narration every fixture merges. */
const NARRATION_SEC = 20

let tmp: { dir: string; cleanup: () => Promise<void> }
before(async () => { tmp = await useTempDataDir() })
after(async () => { await tmp.cleanup() })

let channelCounter = 0
const job = (slug: string) => ({ project_slug: slug, output_lines: [], result: {} }) as any

/**
 * A translated Khmer episode whose merged narration is 20 s, with a Scene Plan stamped against
 * `plannedSec` of narration. `plannedSec === NARRATION_SEC` is a plan retimed onto this narration;
 * anything else is a stamp that did not survive the retime.
 *
 * The plan records `translation_rebase` for the SAME narration, which is exactly why the retime
 * reports "already timed to this narration" (a no-op) instead of rewriting it — so a stale stamp
 * reaches the render's own guard rather than being quietly repaired.
 */
async function translatedEpisode(options: { plannedSec: number; imagePool?: boolean }) {
  channelCounter += 1
  const project = await pm.createProject({
    name: `Translation render ${channelCounter}`,
    content_language: 'km',
    episode_prefix: 'KH',
    episode_digits: 4,
  })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Translated render', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  await ideas.acceptIdea(project.slug, idea!.id, false, { override_code: CODE })
  const paths = await resolveEpisodePathsByCode(project.slug, CODE)
  const episodeDir = paths.episode_dir
  const imagesDir = path.join(episodeDir, 'scene_images')
  await fs.mkdir(imagesDir, { recursive: true })
  await fs.mkdir(paths.merged_audio_dir, { recursive: true })

  // Real PNGs: the valid render walks past the plan check into picture preparation.
  const first = path.join(imagesDir, 's1.png')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16', '-frames:v', '1', first])
  for (const id of ['s2', 's3', 's4']) await fs.writeFile(path.join(imagesDir, `${id}.png`), await fs.readFile(first))

  // The target narration: one chapter (and its audio file, so the merge's own freshness rule can
  // see which chapter the track was built from), its sidecar, and the merged track they describe.
  await fs.mkdir(paths.audio_dir, { recursive: true })
  const chapterFile = `${CODE}_Chapter_01.mp3`
  await fs.writeFile(path.join(paths.audio_dir, chapterFile), 'chapter-audio')
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
    sections: [{ slug: 'Chapter_01', duration_s: NARRATION_SEC, source_file: chapterFile, source_files: [chapterFile] }],
    gap_duration_s: 0,
  }))
  const mergedPath = path.join(paths.merged_audio_dir, MERGED_NAME)
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=${NARRATION_SEC}`,
    '-codec:a', 'libmp3lame', '-q:a', '9', mergedPath,
  ])
  // The merge is newer than the chapter it was built from — a current merge.
  const justBefore = new Date(Date.now() - 60_000)
  await fs.utimes(path.join(paths.audio_dir, chapterFile), justBefore, justBefore)
  await fs.writeFile(path.join(paths.merged_audio_dir, `${CODE}_merged_audio.completion.json`), JSON.stringify({
    output_filename: MERGED_NAME, bytes: (await fs.stat(mergedPath)).size,
    duration_sec: NARRATION_SEC, opening: { lead_in_sec: 0 },
  }))

  // This episode IS a translation, and its plan carries a retime record for the same narration.
  await fs.writeFile(path.join(episodeDir, TRANSLATION_SIDECAR), JSON.stringify({
    schema_version: 1,
    source_slug: 'source-channel',
    source_episode_id: 'EP0001',
    source_language: 'en',
    target_language: 'km',
    title_translated: true,
    translated_at: new Date().toISOString(),
  }, null, 2))

  const perScene = options.plannedSec / 4
  const rows = ['s1', 's2', 's3', 's4'].map((id, index) => ({
    id,
    scene_index: index + 1,
    start_sec: perScene * index,
    end_sec: perScene * (index + 1),
    transcript_segment: `Chapter narration ${index + 1}.`,
    visual_prompt: `Picture ${index + 1}.`,
    approved: true,
  }))
  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    research_used: false,
    opening_mode: 'from-start',
    total_duration_sec: options.plannedSec,
    source_merged_audio: { duration_sec: options.plannedSec },
    scenes: rows,
    translation_rebase: {
      schema_version: 1,
      rule: 'chapter-share',
      source_slug: 'source-channel',
      source_episode_id: 'EP0001',
      rebased_at: new Date().toISOString(),
      narration: { filename: MERGED_NAME, duration_sec: NARRATION_SEC, lead_in_sec: 0 },
      chapters: [{ slug: 'Chapter_01', source_start_sec: 0, source_end_sec: options.plannedSec, target_start_sec: 0, target_end_sec: NARRATION_SEC }],
      scenes: rows.map(row => ({ id: row.id, chapter: 'Chapter_01', share: 0.25, source_start_sec: row.start_sec, source_end_sec: row.end_sec })),
      dropped: [],
    },
  }, null, 2))

  if (options.imagePool) await writeImagePool(project.slug, episodeDir)
  return { slug: project.slug, episodeDir, imagesDir }
}

/** An Image Pool episode: a frozen one-image selection that covers the narration. */
async function writeImagePool(slug: string, episodeDir: string) {
  const poolDir = path.join(tmp.dir, `${slug}-image-pool`)
  await fs.mkdir(poolDir, { recursive: true })
  const imageBytes = Buffer.from('pool-image')
  await fs.writeFile(path.join(poolDir, 'one.png'), imageBytes)
  const sha = createHash('sha256').update(imageBytes).digest('hex')
  await fs.writeFile(path.join(tmp.dir, 'broll-pools.json'), JSON.stringify({ schema_version: 1, pools: [{
    id: 'images', name: 'Images', folder_path: poolDir, media: 'image', auto_normalize: false,
    fps_target: 24, resolution_target: '1920x1080', created_at: new Date().toISOString(),
  }] }))
  await fs.writeFile(path.join(poolDir, '.story-studio-broll.json'), JSON.stringify({ schema_version: 1, pool_name: 'Images', clips: {
    'one.png': {
      filename: 'one.png', duration: 0, width: 1, height: 1, fps: 1, size_bytes: imageBytes.length, sha256: sha,
      normalized: false, tags: [], indexed_at: new Date().toISOString(),
    },
  } }))
  await fs.writeFile(path.join(episodeDir, 'broll-selection.json'), JSON.stringify({
    schema_version: 1, episode_code: CODE, pool_id: 'images', source: 'image_pool', media: 'image',
    selection_mode: 'random', pacing_mode: 'timed', segment_seconds: 5, broll_volume: 0,
    selection: [{ filename: 'one.png', sha256: sha, target_duration: 5 }],
    target_duration: NARRATION_SEC, generated_at: new Date().toISOString(), warnings: [],
  }))
}

/** The refusal text is the naming-scenes one, not the generic stale-plan sentence. */
const TRANSLATION_REFUSAL = /this translated episode's Scene Plan does not follow its narration/i

describe('a translated Scene Plan that is still stale at Video Assembly', () => {
  test('refuses loudly, names the scenes, and renders nothing', async () => {
    const fixture = await translatedEpisode({ plannedSec: 12 })
    const { prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
    const planPath = path.join(fixture.episodeDir, 'scene_plan.json')
    const planBefore = await fs.readFile(planPath)

    await assert.rejects(
      prepareUnifiedVideoAssemblyInputs(fixture.slug, CODE, { subtitles: { enabled: false } } as any, job(fixture.slug)),
      (error: any) => {
        assert.match(error.message, TRANSLATION_REFUSAL)
        assert.match(error.message, /merged narration was 12\.0s .* now 20\.0s/i, 'says which numbers disagree')
        for (const [index, range] of [[1, '0.0–3.0s'], [2, '3.0–6.0s'], [3, '6.0–9.0s'], [4, '9.0–12.0s']] as const) {
          assert.ok(error.message.includes(`#${index} (${range})`), `names scene #${index} (${error.message})`)
        }
        assert.match(error.message, /Nothing was rendered\./)
        return true
      },
    )

    // A refusal is not a partial render: the plan it refused stays exactly as saved, and no
    // video appears in the episode's video folder.
    assert.deepEqual(await fs.readFile(planPath), planBefore, 'the refusal must not rewrite the plan')
    const videos = await fs.readdir(path.join(fixture.episodeDir, `${CODE} - 10 Video Assembly Output`)).catch(() => [] as string[])
    assert.deepEqual(videos.filter(name => name.endsWith('.mp4')), [])
  })

  test('a plan retimed onto this narration passes the check and preparation goes on', async () => {
    const fixture = await translatedEpisode({ plannedSec: NARRATION_SEC })
    const { prepareUnifiedVideoAssemblyInputs, scanEpisodeAssets } = await import('../generators/video.js')
    // The stamp matches the merged track, so the shared rule sees nothing stale to refuse.
    const assets = await scanEpisodeAssets(fixture.slug, CODE)
    assert.equal(assets.scene_plan_timing?.audio_stale_reason, undefined)

    const render = job(fixture.slug)
    await assert.doesNotReject(
      () => prepareUnifiedVideoAssemblyInputs(fixture.slug, CODE, { subtitles: { enabled: false } } as any, render),
    )
  })

  test('an Image Pool render is not refused for a Scene Plan it does not play', async () => {
    const fixture = await translatedEpisode({ plannedSec: 12, imagePool: true })
    const { prepareUnifiedVideoAssemblyInputs, scanEpisodeAssets } = await import('../generators/video.js')
    const { compareMergedAudio } = await import('../lib/scene-plan-timeline.js')
    // The saved plan IS stale (a 12 s stamp over 20 s of narration), and an Image Pool render never
    // reads that plan: the scan publishes no Scene Plan timing to refuse, and preparation goes on.
    const plan = JSON.parse(await fs.readFile(path.join(fixture.episodeDir, 'scene_plan.json'), 'utf-8'))
    assert.equal(compareMergedAudio(plan.source_merged_audio, NARRATION_SEC).stale, true)
    const assets = await scanEpisodeAssets(fixture.slug, CODE)
    assert.equal(assets.visual_source, 'image_pool')
    assert.equal(assets.scene_plan_timing, undefined)

    const req: any = { subtitles: { enabled: false } }
    const render = job(fixture.slug)
    const prepared = await prepareUnifiedVideoAssemblyInputs(fixture.slug, CODE, req, render)
    assert.equal(prepared.visual_source, 'image_pool')
    assert.equal(req.scene_pool_mode, 'image_pool')
    // The single frozen image is cycled across the 20 s narration at 5 s intervals.
    assert.deepEqual(req.scenes.map((scene: any) => path.basename(scene.image_path)), ['one.png', 'one.png', 'one.png', 'one.png'])
  })
})
