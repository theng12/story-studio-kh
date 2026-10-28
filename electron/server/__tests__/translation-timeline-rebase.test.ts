/**
 * Cross-language timeline rebase (v1.4.368) — the defect Production verified:
 *
 * A translated episode gets the source episode's stills, clips, thumbnails and Scene Plan, but the
 * copied plan keeps the SOURCE language's timings (`start_sec` / `end_sec`,
 * `source_merged_audio.duration_sec` and `transcript_segment`). The target narration is a different
 * length in a different language, so the merged-audio freshness check (0.5 s) rejects the plan,
 * "Reconcile timings" cannot match English scene text against Khmer cues, and a rebuild replaces
 * the images the translation exists to reuse.
 *
 * What these tests pin:
 * - a complete retime with a LONGER and with a SHORTER target narration;
 * - sections/chapters anchor the timing (Khmer is script-timed, never ASR);
 * - partial chapters: scenes with no chapter in the target narration are named and not rendered;
 * - a missing target narration is refused, never guessed;
 * - image identity (path, bytes, version, sha, approval) survives byte-for-byte;
 * - the English source episode is untouched;
 * - a Sketch Draw clip goes stale only when its window moved, a provider clip never does;
 * - thumbnails: the source language's drawn headline is never copied, and a clean base is proven
 *   from the source's own text-layer record rather than assumed;
 * - a Retry is idempotent, and a re-merge recomputes from the recorded shares.
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
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { copyVisualAssetsAndScenePlan, TRANSLATION_SIDECAR, type TranslationProvenance } from '../services/translation.js'
import {
  allocateWithinWindow,
  chapterForTime,
  ensureTranslatedEpisodePlanRebased,
  rebaseTranslatedScenePlan,
  readSectionClock,
  sectionWindows,
  sliceTextByShare,
} from '../services/translation-timeline-rebase.js'
import { sceneClipStaleReason } from '../services/scene-media-checkpoint.js'
import { NATIVE_SCENE_CLIP_VERSION } from '../lib/native-scene-clip-version.js'
import { writeChapterFiles } from '../lib/narration-assembly.js'
import type { ScenePlan, ScenePlanEntry } from '../models/types.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

let tmp: { dir: string; cleanup: () => Promise<void> }
before(async () => { tmp = await useTempDataDir() })
after(async () => { await tmp.cleanup() })

let channelCounter = 0
async function channel(language: 'en' | 'km'): Promise<string> {
  channelCounter += 1
  const project = await pm.createProject({
    name: `Rebase ${language} ${channelCounter}`,
    content_language: language,
    episode_prefix: language === 'km' ? 'KH' : 'EP',
    episode_digits: 4,
  })
  return project.slug
}

async function episode(slug: string, code: string, title: string) {
  const [idea] = await ideas.addIdeas(slug, [{
    title, logline: '', themes: [], suggested_chapters: 2, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  await ideas.acceptIdea(slug, idea!.id, false, { override_code: code })
  const paths = await resolveEpisodePathsByCode(slug, code)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  return paths
}

async function silentMp3(dir: string, filename: string, seconds: number): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, filename)
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=${seconds}`,
    '-codec:a', 'libmp3lame', '-q:a', '9', file,
  ])
  return file
}

/** A finished episode's narration: the chapter clock and the merged track that matches it. */
async function narration(
  paths: Awaited<ReturnType<typeof resolveEpisodePathsByCode>>,
  code: string,
  sections: Array<{ slug: string; duration_s: number }>,
  options: { gap_sec?: number; lead_in_sec?: number } = {},
) {
  const gap = options.gap_sec ?? 0
  const leadIn = options.lead_in_sec ?? 0
  const narrationSec = sections.reduce((sum, row) => sum + row.duration_s, 0)
    + Math.max(0, sections.length - 1) * gap
  const total = narrationSec + leadIn
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    sections, gap_duration_s: gap,
  }, null, 2))
  const filename = `${code}_merged_audio.mp3`
  const file = await silentMp3(paths.merged_audio_dir, filename, total)
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
    schema_version: 2,
    output_filename: filename,
    bytes: (await fs.stat(file)).size,
    duration_sec: total,
    opening: { lead_in_sec: leadIn },
  }, null, 2))
  return { narrationSec, total, filename }
}

function scenePlanEntry(over: Partial<ScenePlanEntry> & { id: string; start_sec: number; end_sec: number }): ScenePlanEntry {
  return {
    scene_index: 1,
    transcript_segment: '',
    visual_prompt: `prompt ${over.id}`,
    approved: true,
    image_path: '',
    ...over,
  }
}

async function writePlan(slug: string, code: string, plan: ScenePlan) {
  const paths = await resolveEpisodePathsByCode(slug, code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const planPath = await resolveScenePlanPath(slug, code, paths.episode_dir)
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2))
  return planPath
}

function plan(scenes: ScenePlanEntry[], over: Partial<ScenePlan> = {}): ScenePlan {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    research_used: false,
    total_duration_sec: Math.max(...scenes.map(scene => scene.end_sec)),
    scenes: scenes.map((scene, index) => ({ ...scene, scene_index: index + 1 })),
    source_merged_audio: { duration_sec: Math.max(...scenes.map(scene => scene.end_sec)) },
    ...over,
  }
}

/** A target episode that a translation would have created: sidecar, copied visuals + plan. */
async function translatedEpisode(args: {
  sourceSlug: string
  sourceEpisodeId: string
  targetSlug: string
  targetCode: string
  targetTitle: string
}) {
  const paths = await episode(args.targetSlug, args.targetCode, args.targetTitle)
  await fs.writeFile(path.join(paths.episode_dir, TRANSLATION_SIDECAR), JSON.stringify({
    schema_version: 1,
    source_slug: args.sourceSlug,
    source_episode_id: args.sourceEpisodeId,
    source_language: 'en',
    target_language: 'km',
    title_translated: true,
    translated_at: new Date().toISOString(),
  } satisfies TranslationProvenance, null, 2))
  const copied = await copyVisualAssetsAndScenePlan(
    args.sourceSlug, args.sourceEpisodeId, args.targetSlug, args.targetCode, 'km',
  )
  return { paths, copied }
}

/**
 * An English source episode with two chapters and four scenes: two in Chapter 01 (0–10 s, 10–20 s)
 * and two in Chapter 02 (20–35 s, 35–50 s) of a 50 s narration.
 */
async function englishSource(prefix: string) {
  const slug = await channel('en')
  const code = 'EP0001'
  const paths = await episode(slug, code, `${prefix} Source`)
  await narration(paths, code, [
    { slug: 'Chapter_01', duration_s: 20 },
    { slug: 'Chapter_02', duration_s: 30 },
  ])
  await writeChapterFiles(paths.script_dir, code, `${prefix} Source`, {
    chapters: [
      { number: 1, title: 'Stone', text: 'In the twelfth century the king began building the temple.' },
      { number: 2, title: 'Water', text: 'A vast moat surrounded the temple and mirrored the sunrise.' },
    ],
  }, { normalizeSpokenProse: true })

  await fs.mkdir(paths.bg_dir, { recursive: true })
  const images: string[] = []
  for (const [index, name] of ['scene_01.png', 'scene_02.png', 'scene_03.png', 'scene_04.png'].entries()) {
    const file = path.join(paths.bg_dir, name)
    await fs.writeFile(file, Buffer.concat([PNG, Buffer.from(`scene-${index}`)]))
    images.push(file)
  }
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, 'thumb_01.webp'), Buffer.concat([PNG, Buffer.from('artwork')]))
  // The English headline, drawn on a copy — this is what must never reach the Khmer episode.
  await fs.writeFile(path.join(paths.thumb_dir, 'thumb_01_text-1.png'), Buffer.concat([PNG, Buffer.from('ENGLISH')]))
  await fs.writeFile(path.join(paths.thumb_dir, 'thumb_01_text-1.png.text-layer.json'), JSON.stringify({
    schema: 1, source_filename: 'thumb_01.webp', source_sha256: sha(PNG), source_bytes: PNG.length,
    text: 'THE TEMPLE', style: {}, font_sha256: 'x', rendered_at: new Date().toISOString(), app_version: 'test',
  }, null, 2))

  await writePlan(slug, code, plan([
    scenePlanEntry({ id: 'sc-1', start_sec: 0, end_sec: 10, image_path: images[0]!, transcript_segment: 'In the twelfth century' }),
    scenePlanEntry({ id: 'sc-2', start_sec: 10, end_sec: 20, image_path: images[1]!, transcript_segment: 'the king began building' }),
    scenePlanEntry({ id: 'sc-3', start_sec: 20, end_sec: 35, image_path: images[2]!, transcript_segment: 'A vast moat surrounded' }),
    scenePlanEntry({ id: 'sc-4', start_sec: 35, end_sec: 50, image_path: images[3]!, transcript_segment: 'and mirrored the sunrise' }),
  ]))
  return { slug, code, paths }
}

describe('the chapter clock', () => {
  test('windows are the stitcher’s own cursor math: lead-in, then each chapter and gap', () => {
    const windows = sectionWindows({
      sections: [{ slug: 'Introduction', duration_s: 5 }, { slug: 'Chapter_01', duration_s: 20 }],
      gap_sec: 1,
      lead_in_sec: 3,
    })
    assert.deepEqual(windows, [
      { slug: 'Introduction', start_sec: 3, end_sec: 8, duration_s: 5 },
      { slug: 'Chapter_01', start_sec: 9, end_sec: 29, duration_s: 20 },
    ])
  })

  test('a moment in the gap goes to the nearer chapter, never to nothing', () => {
    const windows = [
      { slug: 'Chapter_01', start_sec: 0, end_sec: 20 },
      { slug: 'Chapter_02', start_sec: 25, end_sec: 50 },
    ]
    assert.equal(chapterForTime(windows, 10), 'Chapter_01')
    assert.equal(chapterForTime(windows, 21), 'Chapter_01')
    assert.equal(chapterForTime(windows, 23), 'Chapter_02')
    assert.equal(chapterForTime(windows, 25), 'Chapter_02')
  })

  test('a chapter too short for its scenes is refused, not squeezed under the render floor', () => {
    assert.throws(() => allocateWithinWindow([1, 1, 1], 0, 1.2), /carries 3 scene\(s\).*at least 0.5s/s)
    const fitting = allocateWithinWindow([1, 3], 0, 10)
    assert.equal(fitting[0]!.start_sec, 0)
    assert.equal(fitting[1]!.end_sec, 10)
    assert.ok(fitting[0]!.end_sec >= 0.5 && fitting[1]!.end_sec - fitting[1]!.start_sec >= 0.5)
  })

  test('text slices fall on word boundaries and never come back empty', () => {
    const text = 'alpha beta gamma delta epsilon'
    assert.equal(sliceTextByShare(text, 0, 0.2), 'alpha beta')
    assert.equal(sliceTextByShare(text, 1, 1), 'epsilon')
    const tiny = sliceTextByShare(text, 0.5, 0.5001)
    assert.ok(tiny.length > 0, 'a slice narrower than a word still yields a word')
  })
})

describe('a complete retime', () => {
  test('a LONGER target narration: chapters anchor the timing, scenes keep their share', async () => {
    const en = await englishSource('Longer')
    const kmSlug = await channel('km')
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'ប្រាសាទ',
    })
    await writeChapterFiles(target.paths.script_dir, 'KH0001', 'ប្រាសាទ', {
      chapters: [
        { number: 1, title: 'ថ្ម', text: 'នៅសតវត្សរ៍ទីដប់ពីរ ព្រះរាជាបានចាប់ផ្តើមកសាងប្រាសាទ។' },
        { number: 2, title: 'ទឹក', text: 'គូទឹកដ៏ធំបានព័ទ្ធជុំវិញប្រាសាទ ហើយឆ្លុះពន្លឺព្រះអាទិត្យ។' },
      ],
    }, { normalizeSpokenProse: true })
    // 30 s + 45 s = 75 s against the source's 50 s.
    await narration(target.paths, 'KH0001', [
      { slug: 'Chapter_01', duration_s: 30 },
      { slug: 'Chapter_02', duration_s: 45 },
    ])

    const sourcePlanBefore = await fs.readFile(await resolveScenePlanPath(en.slug, en.code, en.paths.episode_dir))
    const sourceAudioBefore = await fs.readFile(path.join(en.paths.merged_audio_dir, `${en.code}_merged_audio.mp3`))

    const outcome = await rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' })
    assert.equal(outcome.changed, true)
    assert.equal(outcome.scenes, 4)
    assert.equal(outcome.chapters, 2)
    assert.deepEqual(outcome.dropped, [])

    const planPath = await resolveScenePlanPath(kmSlug, 'KH0001', target.paths.episode_dir)
    const rebased = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.deepEqual(
      rebased.scenes.map(scene => [scene.start_sec, scene.end_sec]),
      [[0, 15], [15, 30], [30, 52.5], [52.5, 75]],
      'each chapter is divided in the source’s own proportions',
    )
    assert.equal(rebased.total_duration_sec, 75)
    assert.deepEqual(rebased.source_merged_audio, { duration_sec: 75 })
    assert.equal(rebased.translation_rebase?.rule, 'chapter-share')
    assert.equal(rebased.translation_rebase?.narration.duration_sec, 75)
    assert.equal(rebased.source_timeline, undefined, 'the source language’s caption stamp is not carried over')

    // The Khmer episode's scene text is Khmer, not the English words it was copied with.
    for (const scene of rebased.scenes) {
      assert.ok(scene.transcript_segment.trim().length > 0, scene.id)
      assert.ok(!/twelfth|moat|sunrise/i.test(scene.transcript_segment), `English text survived on ${scene.id}`)
      assert.match(scene.transcript_segment, /[ក-៿]/, `scene ${scene.id} is not Khmer text`)
    }

    // Image identity and approval are untouched.
    const sourcePlan = JSON.parse(sourcePlanBefore.toString('utf-8')) as ScenePlan
    for (const [index, scene] of rebased.scenes.entries()) {
      assert.equal(scene.id, sourcePlan.scenes[index]!.id)
      assert.equal(scene.image_path, path.join(target.paths.bg_dir, path.basename(sourcePlan.scenes[index]!.image_path!)))
      assert.equal(scene.approved, sourcePlan.scenes[index]!.approved)
      assert.equal(scene.visual_prompt, sourcePlan.scenes[index]!.visual_prompt)
    }
    const targetBytes = await fs.readFile(rebased.scenes[0]!.image_path!)
    const sourceBytes = await fs.readFile(sourcePlan.scenes[0]!.image_path!)
    assert.deepEqual(targetBytes, sourceBytes, 'the picture is the same bytes')

    // The English source episode is untouched.
    assert.deepEqual(await fs.readFile(await resolveScenePlanPath(en.slug, en.code, en.paths.episode_dir)), sourcePlanBefore)
    assert.deepEqual(await fs.readFile(path.join(en.paths.merged_audio_dir, `${en.code}_merged_audio.mp3`)), sourceAudioBefore)
  })

  test('a SHORTER target narration still covers every chapter it has', async () => {
    const en = await englishSource('Shorter')
    const kmSlug = await channel('km')
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'ខ្លី',
    })
    await narration(target.paths, 'KH0001', [
      { slug: 'Chapter_01', duration_s: 8 },
      { slug: 'Chapter_02', duration_s: 12 },
    ])
    const outcome = await rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' })
    assert.equal(outcome.changed, true)
    const planPath = await resolveScenePlanPath(kmSlug, 'KH0001', target.paths.episode_dir)
    const rebased = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.deepEqual(rebased.scenes.map(scene => [scene.start_sec, scene.end_sec]), [[0, 4], [4, 8], [8, 14], [14, 20]])
    assert.equal(rebased.total_duration_sec, 20)
    for (const scene of rebased.scenes) assert.ok(scene.end_sec - scene.start_sec >= 0.5)
  })

  test('partial chapters: scenes of a chapter the narration does not have are named, not rendered', async () => {
    const en = await englishSource('Partial')
    const kmSlug = await channel('km')
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'ខ្លះ',
    })
    // Only Chapter 02 was translated and narrated.
    await narration(target.paths, 'KH0001', [{ slug: 'Chapter_02', duration_s: 40 }])
    const outcome = await rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' })
    assert.equal(outcome.changed, true)
    assert.deepEqual(outcome.dropped.map(entry => entry.id), ['sc-1', 'sc-2'])
    assert.match(outcome.message, /2 scene\(s\) dropped/)
    const planPath = await resolveScenePlanPath(kmSlug, 'KH0001', target.paths.episode_dir)
    const rebased = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.deepEqual(rebased.scenes.map(scene => scene.id), ['sc-3', 'sc-4'])
    assert.deepEqual(rebased.scenes.map(scene => [scene.start_sec, scene.end_sec]), [[0, 20], [20, 40]])
    assert.deepEqual(rebased.scenes.map(scene => scene.scene_index), [1, 2])
    assert.deepEqual(rebased.translation_rebase?.dropped.map(entry => entry.id), ['sc-1', 'sc-2'],
      'the dropped rows are recorded as an audit trail, not silently lost')
  })

  test('a missing target narration is refused and says what to run', async () => {
    const en = await englishSource('MissingAudio')
    const kmSlug = await channel('km')
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'គ្មាន',
    })
    await assert.rejects(
      rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' }),
      (error: any) => error.statusCode === 409 && /no chapter audio durations[\s\S]*Audio Assembly/.test(error.message),
    )
    // No plan was written: the refusal never half-retimes anything.
    const planPath = await resolveScenePlanPath(kmSlug, 'KH0001', target.paths.episode_dir)
    const stillCopied = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.deepEqual(stillCopied.scenes.map(scene => [scene.start_sec, scene.end_sec]), [[0, 10], [10, 20], [20, 35], [35, 50]])
    assert.equal(stillCopied.translation_rebase, undefined)
  })

  test('a chapter sidecar that does not describe the merged track is refused with both numbers', async () => {
    const en = await englishSource('Mismatch')
    const kmSlug = await channel('km')
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'ខុស',
    })
    await narration(target.paths, 'KH0001', [{ slug: 'Chapter_01', duration_s: 20 }])
    // The sidecar claims 20 s of chapter audio, but the merged track is only 10 s.
    await silentMp3(target.paths.merged_audio_dir, 'KH0001_merged_audio.mp3', 10)
    await fs.writeFile(path.join(target.paths.merged_audio_dir, 'KH0001_merged_audio.completion.json'), JSON.stringify({
      output_filename: 'KH0001_merged_audio.mp3', duration_sec: 10, opening: { lead_in_sec: 0 },
    }))
    await assert.rejects(
      rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' }),
      (error: any) => error.statusCode === 409 && /do not describe this track|does not describe this track/.test(error.message),
    )
  })

  test('an episode that is not a translation is left alone', async () => {
    const en = await englishSource('NotTranslated')
    assert.equal(await ensureTranslatedEpisodePlanRebased(en.slug, en.code), null)
  })
})

describe('retry', () => {
  test('running it twice writes nothing the second time', async () => {
    const en = await englishSource('Idempotent')
    const kmSlug = await channel('km')
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'ម្តងទៀត',
    })
    await narration(target.paths, 'KH0001', [
      { slug: 'Chapter_01', duration_s: 30 }, { slug: 'Chapter_02', duration_s: 45 },
    ])
    const first = await rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' })
    assert.equal(first.changed, true)
    const planPath = await resolveScenePlanPath(kmSlug, 'KH0001', target.paths.episode_dir)
    const afterFirst = await fs.readFile(planPath)

    const second = await rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' })
    assert.equal(second.changed, false)
    assert.match(second.skipped_reason || '', /already timed to this narration/)
    assert.deepEqual(await fs.readFile(planPath), afterFirst, 'a Retry does not rewrite the plan')
  })

  test('a re-merged narration recomputes from the recorded shares, not from the times already rewritten', async () => {
    const en = await englishSource('ReMerge')
    const kmSlug = await channel('km')
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'បន្ទាប់',
    })
    await narration(target.paths, 'KH0001', [
      { slug: 'Chapter_01', duration_s: 30 }, { slug: 'Chapter_02', duration_s: 45 },
    ])
    await rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' })

    // The Khmer narration is redone: both chapters now twice as long.
    await narration(target.paths, 'KH0001', [
      { slug: 'Chapter_01', duration_s: 60 }, { slug: 'Chapter_02', duration_s: 90 },
    ])
    const outcome = await rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' })
    assert.equal(outcome.changed, true)
    const planPath = await resolveScenePlanPath(kmSlug, 'KH0001', target.paths.episode_dir)
    const rebased = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.deepEqual(rebased.scenes.map(scene => [scene.start_sec, scene.end_sec]), [[0, 30], [30, 60], [60, 105], [105, 150]],
      'the shares are unchanged, so the old proportions are reproduced — not compounded')
  })
})

describe('clips after a retime', () => {
  const SETTINGS = {
    fps: 30, width: 1920, height: 1080,
    pen: { mode: 'none' as const },
    penFingerprint: sha(Buffer.from('none')),
    hold: { mode: 'auto' as const },
    holdFingerprint: sha(Buffer.from('auto')),
    reveal: null,
    revealFingerprint: sha(Buffer.from('null')),
  }

  function sketchScene(over: Partial<ScenePlanEntry> & { id: string; start_sec: number; end_sec: number }): ScenePlanEntry {
    const window = over.end_sec - over.start_sec
    return scenePlanEntry({
      motion_prompt: 'slow push',
      motion_choice: 'clip',
      clip_renderer: 'sketch_draw',
      clip_source_image_version: 'v1',
      image_sha256: sha(PNG),
      clip_source_image_sha256: sha(PNG),
      clip_scene_window_seconds: window,
      clip_sketch: {
        helper_version: NATIVE_SCENE_CLIP_VERSION, fps: 30, frames: Math.round(window * 30),
        width: 1920, height: 1080, pen_fingerprint: sha(Buffer.from('none')),
        hold_frames: Math.round(window * 30 / 2), hold_fingerprint: sha(Buffer.from('auto')),
      },
      ...over,
    })
  }

  function context(imagePath: string) {
    return { slug: 'clip-channel', episodeId: 'KH0001', episodeDir: tmp.dir, imagePath, sketchSettings: SETTINGS as any }
  }

  test('a Sketch Draw clip is stale only where its window moved; a provider clip is untouched', async () => {
    const en = await englishSource('Clips')
    const kmSlug = await channel('km')
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'ក្លីប',
    })
    const images = (await fs.readdir(target.paths.bg_dir)).sort().map(name => path.join(target.paths.bg_dir, name))
    const planPath = await writePlan(kmSlug, 'KH0001', plan([
      // Chapter 01 keeps its 20 s (10 s + 10 s scenes) — its sketch clip must stay fresh.
      sketchScene({ id: 'sc-1', start_sec: 0, end_sec: 10, image_path: images[0]! }),
      // Chapter 02 grows from 30 s to 45 s — this sketch clip must go stale.
      sketchScene({ id: 'sc-2', start_sec: 20, end_sec: 35, image_path: images[1]! }),
      // A provider clip: Video Assembly trims or holds it, so a moved window changes nothing.
      scenePlanEntry({
        id: 'sc-3', start_sec: 35, end_sec: 50, image_path: images[2]!,
        clip_renderer: 'image_to_video', motion_prompt: 'drift', rendered_motion_prompt: 'drift',
        clip_source_image_version: 'v1', image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG),
        clip_scene_window_seconds: 15,
      }),
      // Chapter 01's second scene, so the shares are 10/10 there.
      sketchScene({ id: 'sc-4', start_sec: 10, end_sec: 20, image_path: images[3]! }),
    ]))
    await narration(target.paths, 'KH0001', [
      { slug: 'Chapter_01', duration_s: 20 }, { slug: 'Chapter_02', duration_s: 45 },
    ])

    const before = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const staleBefore = await Promise.all(before.scenes.map(scene => sceneClipStaleReason(scene, context(scene.image_path!))))
    assert.deepEqual(staleBefore, [null, null, null, null], 'the fixture starts fresh')

    await rebaseTranslatedScenePlan({ targetSlug: kmSlug, targetEpisodeId: 'KH0001' })
    const after = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const byId = new Map(after.scenes.map(scene => [scene.id, scene]))

    // Chapter 01's scenes keep exactly their windows, so their drawings are still valid.
    assert.deepEqual([byId.get('sc-1')!.start_sec, byId.get('sc-1')!.end_sec], [0, 10])
    assert.equal(await sceneClipStaleReason(byId.get('sc-1')!, context(byId.get('sc-1')!.image_path!)), null)

    // Chapter 02's scene grew 15 s → 22.5 s: the one existing freshness rule says so.
    assert.deepEqual([byId.get('sc-2')!.start_sec, byId.get('sc-2')!.end_sec], [30, 52.5])
    assert.match(
      (await sceneClipStaleReason(byId.get('sc-2')!, context(byId.get('sc-2')!.image_path!))) || '',
      /scene length changed/,
    )

    // The provider clip stayed accepted; only its window moved.
    assert.equal(await sceneClipStaleReason(byId.get('sc-3')!, context(byId.get('sc-3')!.image_path!)), null)

    // Nothing in the retime wrote to a clip field.
    for (const id of ['sc-2', 'sc-3']) {
      assert.deepEqual(byId.get(id)!.clip_sketch, before.scenes.find(scene => scene.id === id)!.clip_sketch)
      assert.equal(byId.get(id)!.clip_renderer, before.scenes.find(scene => scene.id === id)!.clip_renderer)
    }
  })
})

describe('thumbnails', () => {
  test('the source language’s drawn headline is never copied, and a clean base is proven not assumed', async () => {
    const en = await englishSource('Thumbs')
    const kmSlug = await channel('km')
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'រូប',
    })
    assert.deepEqual(target.copied.thumbnails?.copied, ['thumb_01.webp'])
    assert.deepEqual(target.copied.thumbnails?.text_variants_skipped, ['thumb_01_text-1.png'])
    assert.equal(target.copied.thumbnails?.clean_base_available, true)
    assert.equal(target.copied.thumbnails?.needs_target_text, true)
    assert.match(target.copied.thumbnails?.note || '', /text-free/)
    const targetThumbs = await fs.readdir(target.paths.thumb_dir)
    assert.deepEqual(targetThumbs, ['thumb_01.webp'], 'no English headline reached the Khmer episode')
  })

  test('without a text-layer record nothing is assumed about the artwork', async () => {
    const en = await englishSource('ThumbsUnknown')
    const kmSlug = await channel('km')
    await fs.rm(path.join(en.paths.thumb_dir, 'thumb_01_text-1.png'), { force: true })
    await fs.rm(path.join(en.paths.thumb_dir, 'thumb_01_text-1.png.text-layer.json'), { force: true })
    const target = await translatedEpisode({
      sourceSlug: en.slug, sourceEpisodeId: en.code, targetSlug: kmSlug, targetCode: 'KH0001', targetTitle: 'មិនដឹង',
    })
    assert.equal(target.copied.thumbnails?.clean_base_available, false)
    assert.equal(target.copied.thumbnails?.needs_target_text, true)
    assert.match(target.copied.thumbnails?.note || '', /nothing proves they are free of English text/)
  })
})

describe('the section clock reads what the merge recorded', () => {
  test('the target clock is the merged track’s own numbers, including a lead-in', async () => {
    const kmSlug = await channel('km')
    const paths = await episode(kmSlug, 'KH0001', 'Clock')
    await narration(paths, 'KH0001', [
      { slug: 'Introduction', duration_s: 5 }, { slug: 'Chapter_01', duration_s: 20 },
    ], { gap_sec: 1, lead_in_sec: 4 })
    const clock = await readSectionClock(kmSlug, 'KH0001')
    assert.equal(clock.lead_in_sec, 4)
    assert.equal(clock.narration_sec, 30)
    assert.deepEqual(sectionWindows(clock), [
      { slug: 'Introduction', start_sec: 4, end_sec: 9, duration_s: 5 },
      { slug: 'Chapter_01', start_sec: 10, end_sec: 30, duration_s: 20 },
    ])
  })
})
