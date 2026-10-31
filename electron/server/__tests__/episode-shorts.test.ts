import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { UpdateConfigSchema } from '../contracts/index.js'
import { shortsPerEpisode, validateShortMoments, narrationOffset, verifyShort, trashPreviousShorts, autoEnqueueEpisodeShorts, shortCutArgs } from '../services/episode-shorts.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { videoAssemblySourceStampPath } from '../services/video-visual-source.js'

let root: string
let cleanup: () => Promise<void>
before(async () => { const temp = await useTempDataDir(); root = temp.dir; cleanup = temp.cleanup })
after(async () => { await cleanup() })
const cues = Array.from({ length: 12 }, (_, i) => ({ index: i + 1, start_sec: i * 10, end_sec: (i + 1) * 10, text: `Sentence ${i}` }))
const rows = [{ start: 0, end: 30, title: 'First', reason: 'A complete idea' }, { start: 40, end: 70, title: 'Second', reason: 'Another idea' }]
const select = (items: unknown) => validateShortMoments(JSON.stringify({ shorts: items }), cues, 2)

test('the switch defaults off and accepts only whole numbers from zero to three', () => {
  for (const value of [undefined, null, -1, 4, 1.5, '2']) assert.equal(shortsPerEpisode(value), 0)
  for (const value of [0, 1, 2, 3]) { assert.equal(shortsPerEpisode(value), value); assert.equal(UpdateConfigSchema.safeParse({ shorts_per_episode: value }).success, true) }
  for (const value of [null, -1, 4, 1.5, '2']) assert.equal(UpdateConfigSchema.safeParse({ shorts_per_episode: value }).success, false)
})

test('passages snap to cue boundaries and invalid selections fail loudly', () => {
  assert.deepEqual(select([{ ...rows[0], start: 1, end: 29 }, rows[1]]), rows)
  assert.throws(() => validateShortMoments('{broken', cues, 2), /JSON/)
  assert.throws(() => select([rows[0], { ...rows[1], start: 20 }]), /overlaps/)
  assert.throws(() => select([{ ...rows[0], end: 60 }, { ...rows[1], start: 70, end: 100 }]), /20–58/)
  assert.throws(() => select([{ ...rows[0], start: -1 }, rows[1]]), /out-of-range/)
})

test('the actual render offset is tied to its final file, including a title intro', async () => {
  const video = path.join(root, 'EP0001_final_video.mp4')
  await fs.writeFile(video, 'final')
  const stat = await fs.stat(video)
  const stamp = videoAssemblySourceStampPath(video, 'EP0001')
  await fs.writeFile(stamp, JSON.stringify({ final_video: { size: stat.size, mtime_ms: Math.round(stat.mtimeMs) }, narration_offset_sec: 5 }))
  const offset = await narrationOffset(video, 'EP0001')
  assert.equal(offset, 5)
  const args = shortCutArgs(video, 'clip.mp4', { start: 30, end: 55, title: 'title', reason: 'reason' }, offset)
  assert.equal(args[args.indexOf('-ss') + 1], '35')
  assert.equal(args[args.indexOf('-t') + 1], '25')
  await fs.appendFile(video, 'changed')
  await assert.rejects(narrationOffset(video, 'EP0001'), /another render/)
})

test('a resumed final stamps its saved narration timing', async () => {
  const source = await fs.readFile(new URL('../generators/video.ts', import.meta.url), 'utf8')
  assert.match(source, /narrationOffsetSec: carriedFinalStage\.narration_offset_sec/)
  assert.match(source, /narrationOffsetSec: opts\.narrationOffsetSec/)
  assert.match(source, /narration_offset_sec: ctx\.narrationOffsetSec/)
  assert.match(source, /narrationOffsetSec: stage\.narration_offset_sec/)
  assert.match(source, /narrationOffsetSec: narrationLeadInSec/)
  const checkpoint = await fs.readFile(new URL('../lib/video-assembly-checkpoint.ts', import.meta.url), 'utf8')
  assert.match(checkpoint, /return \{ \.\.\.stage, argv: stage\.argv\.map\(swap\), files: here\.files \}/)
  const { finishImportedFinalVideo } = await import('../generators/video.js')
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Shorts resumed stamp' })
  const final = path.join(root, 'EP1001_final_video.mp4')
  await fs.writeFile(final, 'video')
  await finishImportedFinalVideo({ project_slug: project.slug, output_lines: [], result: {}, progress: 0 } as any, 'EP1001', final, 'scene_plan', null, 4.25)
  assert.equal(JSON.parse(await fs.readFile(videoAssemblySourceStampPath(final, 'EP1001'), 'utf8')).narration_offset_sec, 4.25)
})

test('a compilation final stamps the zero-delay mix', async () => {
  const source = await fs.readFile(new URL('../generators/video.ts', import.meta.url), 'utf8')
  assert.match(source, /job, code, compResolvedPath, authoritativeAssets\.visual_source \|\| 'scene_plan', authoritativeAssets\.image_pool, 0/)
  const { finishImportedFinalVideo } = await import('../generators/video.js')
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Shorts compilation stamp' })
  const final = path.join(root, 'EP1002_final_video.mp4')
  await fs.writeFile(final, 'video')
  await finishImportedFinalVideo({ project_slug: project.slug, output_lines: [], result: {}, progress: 0 } as any, 'EP1002', final, 'scene_plan', null, 0)
  assert.equal(JSON.parse(await fs.readFile(videoAssemblySourceStampPath(final, 'EP1002'), 'utf8')).narration_offset_sec, 0)
})

test('B-roll assembly maps narration from its own start and stamps zero', async () => {
  const source = await fs.readFile(new URL('../generators/broll-assemble.ts', import.meta.url), 'utf8')
  assert.match(source, /args\.push\('-i', narrationPath\)/)
  assert.match(source, /input\.narrationEvidence,\s*0,\s*\)/)
  const { writeVideoAssemblySourceStamp } = await import('../services/video-visual-source.js')
  const final = path.join(root, 'EP1003_final_video.mp4')
  await fs.writeFile(final, 'video')
  await writeVideoAssemblySourceStamp(final, 'EP1003', 'scene_plan', null, undefined, 0)
  assert.equal(JSON.parse(await fs.readFile(videoAssemblySourceStampPath(final, 'EP1003'), 'utf8')).narration_offset_sec, 0)
})

test('verification distinguishes complete, missing, wrong size and missing audio', async () => {
  const info = { hasVideo: true, hasAudio: true, width: 1080, height: 1920, durationSec: 30, containerNames: ['mp4'], containerBrand: null, container: 'mp4' as const }
  assert.equal(await verifyShort('clip', 30, async () => info), null)
  assert.match((await verifyShort('clip', 30, async () => { throw new Error('missing') }))!, /missing/)
  assert.match((await verifyShort('clip', 30, async () => ({ ...info, width: 720 })))!, /size/)
  assert.match((await verifyShort('clip', 30, async () => ({ ...info, hasAudio: false })))!, /audio/)
  assert.match((await verifyShort('clip', 30, async () => ({ ...info, durationSec: 29 })))!, /duration/)
})

test('the FFmpeg cut makes a vertical file with audio at the selected offset', async () => {
  const source = path.join(root, 'source.mp4'), output = path.join(root, 'cut.mp4')
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=2:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source])
  await runFfmpeg(shortCutArgs(source, output, { start: 0, end: 2, title: 'test', reason: 'test' }, 1))
  assert.equal(await verifyShort(output, 2), null)
})

test('rerunning moves the previous Shorts folder to Story Trash', async () => {
  const project = path.join(root, 'channel'), dir = path.join(project, 'episodes', 'EP0001', 'shorts')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'EP0001-short-1.mp4'), 'previous')
  trashPreviousShorts(dir, project, 'channel')
  await assert.rejects(fs.stat(dir))
  assert.equal(await fs.readFile(path.join(root, '_trash', 'channel', 'shorts', 'EP0001', 'shorts', 'EP0001-short-1.mp4'), 'utf8'), 'previous')
})

test('default-off hook does nothing and a failed hook cannot fail a finished render', async () => {
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Shorts hook test' })
  const job: any = { project_slug: project.slug, output_lines: [], result: {}, progress: 0 }
  await autoEnqueueEpisodeShorts(job, project.slug, 'EP0001')
  assert.deepEqual(job.output_lines, [])
  await pm.updateConfig(project.slug, { shorts_per_episode: 2 } as any)
  const final = path.join(root, 'hook.mp4')
  await fs.writeFile(final, 'video')
  const { finishImportedFinalVideo } = await import('../generators/video.js')
  await finishImportedFinalVideo(job, 'EP0001', final, 'scene_plan', null)
  assert.equal(job.progress, 100)
  assert.ok(job.output_lines.some((line: string) => line.includes('Could not start Shorts')))
})
