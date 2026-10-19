/**
 * 1.4.278 — Brain Wise EP0039/EP0040/EP0041: Video Assembly stopped on "11 timing overlap(s)
 * totalling 4.0s" (and 2 / 0.5 s). Scene Plan's "Reconcile timings" fixed the same thing on EP0035
 * while keeping every scene and image. Small overlaps (≤ 2 s each, ≤ 5 s in all) are now repaired
 * that way before assembly and logged. 1.4.296 — overlaps of ANY size are (Brain Wise EP0044-EP0048
 * stopped on 2.9-49 s).
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'

const SLUG = 'small-overlap-repair'
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  tmp = await useTempDataDir()
  const projectDir = path.join(tmp.dir, 'projects', SLUG)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Small Overlap Repair', episode_prefix: 'EP', season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [1, 2].map(i => ({ id: `idea-${i}`, title: `Ep ${i}`, status: 'accepted', episode_code: `EP000${i}` })),
    next_episode_number: 3, recycled_numbers: [],
  }))
})

after(async () => { await tmp.cleanup() })

/** Twelve 5 s scenes over matching captions; `overlaps` pushes scene ends past the next start. */
async function episode(code: string, overlaps: number[]) {
  const n = Number(code.slice(-1))
  const episodeDir = path.join(tmp.dir, 'projects', SLUG, 'episodes', 'Season 001', `${code} - Ep ${n}`)
  const imagesDir = path.join(episodeDir, 'scene_images')
  const mergedDir = path.join(episodeDir, `${code} - 08 Audio Merge Output`)
  const subtitlesDir = path.join(episodeDir, `${code} - 09 Subtitles Output`)
  for (const dir of [imagesDir, mergedDir, subtitlesDir]) await fs.mkdir(dir, { recursive: true })
  const total = WORDS.length * 5
  const scenes = WORDS.map((word, i) => ({
    id: `s${i + 1}`, scene_index: i + 1, start_sec: i * 5, end_sec: (i + 1) * 5 + (overlaps[i] || 0),
    transcript_segment: `${word} one two three`, visual_prompt: word, approved: true,
  }))
  for (const scene of scenes) await fs.writeFile(path.join(imagesDir, `${scene.id}.png`), 'png')
  const planPath = path.join(episodeDir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1, generated_at: new Date().toISOString(), research_used: false, opening_mode: 'from-start',
    total_duration_sec: total, scenes,
  }))
  const t = (sec: number) => `00:00:${String(sec).padStart(2, '0')},000`
  await fs.writeFile(path.join(subtitlesDir, `${code}_stitched.srt`), WORDS
    .map((word, i) => `${i + 1}\n${t(i * 5)} --> ${t((i + 1) * 5)}\n${word} one two three\n`).join('\n'))
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=${total}`,
    '-codec:a', 'libmp3lame', '-q:a', '9', path.join(mergedDir, `${code}_merged_audio.mp3`),
  ])
  return { planPath, scenes }
}

const job = () => ({ output_lines: [] as string[] }) as any

test('EP0039-like small overlaps are reconciled before assembly, keeping every scene and image', async () => {
  // Eleven overlaps of 0.2-0.5 s, 4.0 s in all — Brain Wise EP0039's numbers.
  const overlaps = [0.5, 0.4, 0.3, 0.4, 0.3, 0.4, 0.3, 0.4, 0.3, 0.4, 0.3]
  const { planPath, scenes } = await episode('EP0001', overlaps)
  const { scanEpisodeAssets, prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  const before = await scanEpisodeAssets(SLUG, 'EP0001')
  assert.equal(before.scene_plan_timing!.overlap_count, 11)
  assert.equal(before.scene_plan_timing!.overlap_sec.toFixed(1), '4.0')

  const render = job()
  await prepareUnifiedVideoAssemblyInputs(SLUG, 'EP0001', {} as any, render).catch((error: Error) => {
    assert.doesNotMatch(error.message, /timing overlap/, 'whatever else this fixture lacks, overlaps no longer block')
  })
  const line = render.output_lines.find((l: string) => l.startsWith('Scene Plan: 11 timing overlap(s) totalling 4.0s'))
  assert.ok(line, render.output_lines.join('\n'))
  assert.match(line, /every scene and image kept\. Overlaps now: 0\./)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
  assert.deepEqual(plan.scenes.map((s: any) => s.id), scenes.map(s => s.id))
  assert.equal((await scanEpisodeAssets(SLUG, 'EP0001')).scene_plan_timing!.overlap_count, 0)
})

test('a large overlap is re-aligned too, instead of stopping Video Assembly (1.4.296)', async () => {
  const { planPath, scenes } = await episode('EP0002', [3])
  const { scanEpisodeAssets, prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  const render = job()
  await prepareUnifiedVideoAssemblyInputs(SLUG, 'EP0002', {} as any, render).catch((error: Error) => {
    assert.doesNotMatch(error.message, /timing overlap/, 'whatever else this fixture lacks, overlaps no longer block')
  })
  assert.ok(render.output_lines.some((l: string) => l.startsWith('Scene Plan: 1 timing overlap(s) totalling 3.0s')), render.output_lines.join('\n'))
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
  assert.deepEqual(plan.scenes.map((s: any) => s.id), scenes.map(s => s.id))
  assert.ok(plan.source_timeline?.sha256, 'the re-aligned plan records the captions it now follows')
  assert.equal((await scanEpisodeAssets(SLUG, 'EP0002')).scene_plan_timing!.overlap_count, 0)
})

test('a plan timed against a slightly different narration is re-aligned, not refused (1.4.296)', async () => {
  // mineepod EP0006: "the merged narration was 992.6s when this plan was built and is now 991.8s".
  const { planPath } = await episode('EP0003', [])
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
  await fs.writeFile(planPath, JSON.stringify({ ...plan, source_merged_audio: { duration_sec: 60.9 } }))
  const { scanEpisodeAssets, prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  assert.match((await scanEpisodeAssets(SLUG, 'EP0003')).scene_plan_timing!.audio_stale_reason || '', /60\.9s/)
  const render = job()
  await prepareUnifiedVideoAssemblyInputs(SLUG, 'EP0003', {} as any, render).catch((error: Error) => {
    assert.doesNotMatch(error.message, /out of date/, 'whatever else this fixture lacks, the drift no longer blocks')
  })
  assert.ok(render.output_lines.some((l: string) => /^Scene Plan: out of step with the narration/.test(l)), render.output_lines.join('\n'))
  assert.equal((await scanEpisodeAssets(SLUG, 'EP0003')).scene_plan_timing!.audio_stale_reason, undefined)
})

test('a stale picture is used as it is and named, instead of blocking (1.4.296)', async () => {
  const { planPath } = await episode('EP0004', [])
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
  plan.scenes[2].rendered_prompt = 'an older wording'
  await fs.writeFile(planPath, JSON.stringify(plan))
  const { prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  const render = job()
  await prepareUnifiedVideoAssemblyInputs(SLUG, 'EP0004', {} as any, render).catch((error: Error) => {
    assert.doesNotMatch(error.message, /stale/, 'whatever else this fixture lacks, a stale picture no longer blocks')
  })
  assert.ok(render.output_lines.some((l: string) => /^1 scene picture\(s\) were drawn from an older prompt \(#3\); using them as they are/.test(l)), render.output_lines.join('\n'))
})

test('re-aligning never leaves a scene with no length (1.4.298, Brain Wise EP0047)', async () => {
  // Scenes 1 and 2 are both inside the first caption, so both anchor to its start.
  const { planPath, scenes } = await episode('EP0005', [0.5])
  const subtitles = path.join(path.dirname(planPath), 'EP0005 - 09 Subtitles Output', 'EP0005_stitched.srt')
  const srt = await fs.readFile(subtitles, 'utf-8')
  await fs.writeFile(subtitles, srt.replace('00:00:05,000\nalpha one two three', '00:00:10,000\nalpha one two three bravo one two three')
    .replace(/2\n00:00:05,000 --> 00:00:10,000\nbravo one two three\n\n/, ''))
  const { reconcileScenePlanTimings } = await import('../services/scene-plan-reconcile.js')
  const r = await reconcileScenePlanTimings(SLUG, 'EP0005', { auto: true })
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
  assert.ok(plan.scenes.every((s: any) => s.end_sec > s.start_sec), JSON.stringify(plan.scenes.slice(0, 3)))
  // 1.4.324 — the shared caption start is spread, not deleted: this fixture's six tied
  // scenes used to be dropped from the plan (with their approved images) to satisfy the
  // line above. Every scene now keeps a real window AND its image and approval.
  assert.deepEqual(plan.scenes.map((s: any) => s.id), scenes.map(s => s.id))
  assert.ok(plan.scenes.every((s: any) => s.approved === true), 'no approval is dropped with the tie')
  assert.ok(r.changes.some((c: string) => /shared a caption start/.test(c)), r.changes.join('\n'))
  assert.ok(!r.changes.some((c: string) => /no length/.test(c)), r.changes.join('\n'))
})
