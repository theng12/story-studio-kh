/**
 * Motion Review's scene-clip import (owner, 2026-10-27: "import any supported format").
 *
 * The upload used to accept MP4 only (an `ftyp` sniff). Now the file is probed with ffprobe
 * and converted ON IMPORT into the shape assembly expects — H.264 in MP4, yuv420p, bt709,
 * constant frame rate — by the one existing clip encoder. A file ffmpeg cannot decode, or
 * one with no video stream, is refused by name and the accepted clip is left alone.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { getMediaInfo } from '../lib/ffmpeg-validation.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { resolveVideoAssetsDir } from '../generators/scene-clip.js'

let app: any
let cleanup: () => Promise<void>
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-clip-import-test-'))

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
})

after(async () => {
  await cleanup()
  await fs.rm(work, { recursive: true, force: true })
})

/** A channel + accepted episode with a one-scene plan, ready for a clip upload. */
async function makeEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Clip import fixture', logline: 'A deterministic import fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    scenes: [{ id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8, approved: true, visual_prompt: 'A still archive.', motion_prompt: 'A slow drift.' }],
  }))
  return { slug: project.slug, episodeId: accepted.episode_code, paths, planPath }
}

function upload(slug: string, episodeId: string, bytes: Buffer, type: string, fileName?: string) {
  const req = request(app)
    .post(`/api/projects/${slug}/scene-review/${episodeId}/upload-clip/scene-a`)
    .set('Content-Type', type)
  if (fileName) req.set('X-File-Name', encodeURIComponent(fileName))
  return req.send(bytes)
}

test('a .mov in another codec is accepted and normalised into the render shape', async () => {
  const fixture = await makeEpisode('Clip import normalise')
  const ffmpeg = await getFFmpegPath()
  const source = path.join(work, 'source.mov')
  // MPEG-4 part 2 in a QuickTime container: a container AND codec that are not the
  // render shape, encoded with the same ffmpeg the app uses.
  await promisify(execFile)(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=teal:s=64x48:r=10:d=1',
    '-c:v', 'mpeg4', '-q:v', '5', source,
  ])

  const response = await upload(fixture.slug, fixture.episodeId, await fs.readFile(source), 'video/quicktime', 'source.mov')
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.saved_as, 'scene-a.mp4')
  assert.equal(response.body.converted, true, 'a foreign format is converted, not stored as-is')
  assert.ok(Math.abs(response.body.duration_seconds - 1) < 0.2, `duration ${response.body.duration_seconds}`)

  const clipsDir = await resolveVideoAssetsDir(fixture.slug, fixture.episodeId, fixture.paths.episode_dir)
  const saved = path.join(clipsDir, 'scene-a.mp4')
  const info = await getMediaInfo(saved)
  assert.equal(info.hasVideo, true)
  assert.equal(info.videoCodec, 'h264', 'assembly copies a clip only when the codec is H.264')
  assert.equal(info.pixelFormat, 'yuv420p')
  assert.equal(info.container, 'mp4')
  assert.ok(!(await fs.readdir(clipsDir)).some(name => name.startsWith('.tmp_')), 'no temp file is left in the assets folder')

  const plan = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
  assert.equal(plan.scenes[0].clip_path, saved)
  assert.equal(plan.scenes[0].clip_renderer, 'external')
  assert.equal(plan.scenes[0].motion_choice, 'pending', 'an upload is reviewed before it is used')
})

test('an MP4 upload is accepted and ends up as the scene clip', async () => {
  const fixture = await makeEpisode('Clip import mp4')
  const ffmpeg = await getFFmpegPath()
  const source = path.join(work, 'shaped.mp4')
  await promisify(execFile)(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x48:r=10:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source,
  ])

  const response = await upload(fixture.slug, fixture.episodeId, await fs.readFile(source), 'video/mp4', 'shaped.mp4')
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const clipsDir = await resolveVideoAssetsDir(fixture.slug, fixture.episodeId, fixture.paths.episode_dir)
  const info = await getMediaInfo(path.join(clipsDir, 'scene-a.mp4'))
  assert.equal(info.videoCodec, 'h264')
  assert.equal(info.container, 'mp4')
  assert.ok(Math.abs(Number(info.videoDurationSec) - 1) < 0.2)
})

test('an undecodable file is refused by name, and the accepted clip is left alone', async () => {
  const fixture = await makeEpisode('Clip import refusal')
  const clipsDir = await resolveVideoAssetsDir(fixture.slug, fixture.episodeId, fixture.paths.episode_dir)
  await fs.mkdir(clipsDir, { recursive: true })
  const accepted = path.join(clipsDir, 'scene-a.mp4')
  const previous = Buffer.from('the clip that was already accepted')
  await fs.writeFile(accepted, previous)

  const response = await upload(fixture.slug, fixture.episodeId, Buffer.from('not a video at all'), 'video/quicktime', 'holiday.mov')
  assert.equal(response.status, 400, JSON.stringify(response.body))
  assert.match(response.body.detail, /holiday\.mov/, 'the refusal names the file the customer chose')
  assert.match(response.body.detail, /could not be decoded/)
  assert.match(response.body.detail, /Nothing was changed/)
  assert.deepEqual(await fs.readFile(accepted), previous, 'a refused import never replaces the accepted clip')
})

test('a file with no video stream is refused by name', async () => {
  const fixture = await makeEpisode('Clip import audio only')
  const ffmpeg = await getFFmpegPath()
  const audio = path.join(work, 'voice.m4a')
  await promisify(execFile)(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac', audio])

  const response = await upload(fixture.slug, fixture.episodeId, await fs.readFile(audio), 'application/octet-stream', 'voice.m4a')
  assert.equal(response.status, 400, JSON.stringify(response.body))
  assert.match(response.body.detail, /voice\.m4a/)
  assert.match(response.body.detail, /no video stream/)
})
