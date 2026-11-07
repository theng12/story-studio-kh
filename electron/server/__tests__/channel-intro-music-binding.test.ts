/**
 * 1.4.386 — automatic channel intro music binding + trims/fades at the merge.
 *
 * Pinned here:
 *   1. A request that does NOT state `channel_intro` binds the channel's
 *      configured `channel_intro_music`, frozen at the job boundary with its
 *      trims/fades intact.
 *   2. An explicit `null` clear wins over that binding.
 *   3. An episode's own saved choice wins over the channel default.
 *   4. The generator applies the trim once, at the concat input, and records
 *      the TRIMMED duration — the opening/subtitle offset adds it once.
 *
 * ZERO paid calls: the route is exercised with the queue paused; the generator
 * run is local ffmpeg sine only.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { app } = await import('../app.js')
const pm = await import('../services/project-manager.js')
const queue = await import('../services/job-queue.js')
await queue.setQueuePaused(true)
const { resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
const { generateAudioMerge } = await import('../generators/audio-merge.js')
const { toPortablePath } = await import('../services/path-resolver.js')

after(async () => { await temp.cleanup() })

async function makeEpisode(tag: string) {
  const project = await pm.createProject({
    name: `Intro binding ${tag} ${Math.random().toString(36).slice(2, 7)}`,
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  const outputRoot = (await pm.getProjectOutputRoot(project.slug))!
  const episodeDir = path.join(outputRoot, 'EP001 - Test')
  await fs.mkdir(episodeDir, { recursive: true })
  await fs.writeFile(path.join(episodeDir, 'EP001_Script_Narration.md'), [
    '# Narration', '## Chapter 1: One', 'The first chapter is short.',
  ].join('\n\n'))
  const audioDir = await resolveAudioDir(project.slug, await findNarrationFile(project.slug, 'EP001'), 'EP001')
  await fs.mkdir(audioDir, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'libmp3lame', path.join(audioDir, 'EP001_Chapter_01.mp3')])
  const introPath = path.join(outputRoot, 'assets', 'Channel Intro.mp3')
  await fs.mkdir(path.dirname(introPath), { recursive: true })
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6',
    '-c:a', 'libmp3lame', introPath])
  return { slug: project.slug, outputRoot, introPath, introPortable: toPortablePath(introPath, outputRoot) }
}

const channelIntroMusic = (file: string) => ({
  file,
  volume: 0.5,
  gap_after: 1.5,
  trim_start_sec: 1,
  duration_sec: 3,
  fade_in_sec: 0.5,
  fade_out_sec: 1,
})

void test('a request that states no intro binds the channel default, frozen with its trims and fades', async () => {
  const ep = await makeEpisode('auto')
  await pm.updateConfig(ep.slug, { channel_intro_music: channelIntroMusic(ep.introPortable) } as any)

  const response = await request(app).post(`/api/projects/${ep.slug}/generate/audio-merge`).send({
    episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false,
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  const intro = response.body.params.channel_intro
  assert.ok(intro, 'the channel default must be bound')
  assert.equal(intro.enabled, true)
  assert.notEqual(intro.file, ep.introPortable, 'the intro bytes were frozen at the job boundary')
  assert.match(intro.sha256, /^[a-f0-9]{64}$/)
  assert.equal(intro.trim_start_sec, 1)
  assert.equal(intro.duration_sec, 3)
  assert.equal(intro.fade_in_sec, 0.5)
  assert.equal(intro.fade_out_sec, 1)
  assert.equal(intro.gap_after, 1.5)
  assert.equal(intro.volume, 0.5)
})

void test('an explicit null clear wins over the channel default', async () => {
  const ep = await makeEpisode('clear')
  await pm.updateConfig(ep.slug, { channel_intro_music: channelIntroMusic(ep.introPortable) } as any)

  const response = await request(app).post(`/api/projects/${ep.slug}/generate/audio-merge`).send({
    episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false, channel_intro: null,
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal('channel_intro' in response.body.params, false, 'a deliberate clear must bind nothing')
})

void test("an episode's saved choice wins over the channel default", async () => {
  const ep = await makeEpisode('episode')
  const ownPath = path.join(ep.outputRoot, 'assets', 'Episode Choice.mp3')
  await fs.copyFile(ep.introPath, ownPath)
  await pm.updateConfig(ep.slug, {
    channel_intro_music: channelIntroMusic(ep.introPortable),
    video_assembly_last_used: {
      episodes: {
        EP001: {
          episode_id: 'EP001',
          saved_at: new Date().toISOString(),
          settings: { channel_intro: { file: toPortablePath(ownPath, ep.outputRoot), volume: 1, gap_after: 0 } },
        },
      },
    },
  } as any)

  const response = await request(app).post(`/api/projects/${ep.slug}/generate/audio-merge`).send({
    episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false,
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  const intro = response.body.params.channel_intro
  assert.equal(intro.name, 'Episode Choice.mp3', 'the saved episode pick is not overwritten')
  assert.equal(intro.trim_start_sec, 0, 'the channel default’s trims must not leak onto the episode pick')
})

void test('the generator trims the intro once and records the trimmed duration', async () => {
  const ep = await makeEpisode('trim')
  const job: any = {
    job_id: `merge-${Math.random().toString(36).slice(2, 7)}`, project_slug: ep.slug, type: 'audio_merge',
    episode_id: 'EP001', title: 'Audio Assembly', status: 'running', created_at: new Date().toISOString(),
    started_at: null, finished_at: null, error: null, output_lines: [],
    params: {
      episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false,
      channel_intro: {
        enabled: true, file: ep.introPath, volume: 1, gap_after: 0,
        trim_start_sec: 1, duration_sec: 3, fade_in_sec: 0.5, fade_out_sec: 1,
      },
    },
  }
  await generateAudioMerge(job)

  const hits: string[] = []
  const walk = async (dir: string) => {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) await walk(p)
      else if (ent.name === 'EP001_merged_audio.completion.json') hits.push(p)
    }
  }
  await walk(ep.outputRoot)
  assert.equal(hits.length, 1, `expected one completion record, found ${hits.length}`)
  const record = JSON.parse(await fs.readFile(hits[0]!, 'utf8'))
  const duration = record.opening.intro.duration_sec
  assert.ok(Math.abs(duration - 3) < 0.15, `the record must report the trimmed 3s intro, got ${duration}`)
  assert.ok(Math.abs(record.opening.lead_in_sec - 3) < 0.15,
    `the opening offset must count the trimmed intro once, got ${record.opening.lead_in_sec}`)
  assert.ok(job.output_lines.some((l: string) => l.includes('Intro trimmed to')), job.output_lines.join('\n'))
})
