/**
 * Audio Assembly's explicit Apply (VA step 2) may ask the merge endpoint to
 * reuse the channel's EXISTING selected preset (`reuse_saved_settings: true`).
 * The preset is resolved by the same `resolveStepParams('audio_merge', …)` the
 * Pipeline uses; only the episode, the explicitly chosen channel intro (or a
 * deliberate `null` clear) and `write_mode` may ride over it. A missing preset
 * or an unstated intro choice is refused — never defaulted.
 *
 * ZERO paid calls: the route is exercised directly and the job is only queued.
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

after(async () => { await temp.cleanup() })

/** One accepted chapter with real audio, plus an adopted intro asset. */
async function makeEpisode(tag: string) {
  const project = await pm.createProject({
    name: `Saved settings ${tag} ${Math.random().toString(36).slice(2, 7)}`,
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
  const introPath = path.join(outputRoot, 'assets', 'Intro.mp3')
  await fs.mkdir(path.dirname(introPath), { recursive: true })
  await fs.writeFile(introPath, Buffer.from('saved-settings intro bytes'))
  return { slug: project.slug, introPath }
}

async function saveMixerPreset(slug: string) {
  await pm.updateConfig(slug, {
    audio_merge_presets: [{
      id: 'saved-mixer',
      name: 'Saved mixer',
      data: {
        gap_duration: 1,
        normalize_volume: true,
        narration_volume: 80,
        music: { enabled: true, source: 'manual', files: [], volume: 12 },
      },
    }],
    audio_merge_last_preset: 'saved-mixer',
  } as any)
}

test('a request without the flag keeps today’s behaviour: its own values win, no preset is read', async () => {
  const { slug } = await makeEpisode('unchanged')
  await saveMixerPreset(slug)
  const response = await request(app).post(`/api/projects/${slug}/generate/audio-merge`).send({
    episode_id: 'EP001', chapters: [], gap_duration: 7, normalize_volume: true,
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(response.body.params.gap_duration, 7)
  assert.equal(response.body.params.normalize_volume, true)
  assert.equal(response.body.params.reuse_saved_settings, undefined)
})

test('the flag uses the selected preset’s mixer settings and freezes the explicit intro', async () => {
  const { slug, introPath } = await makeEpisode('reuse')
  await saveMixerPreset(slug)
  const response = await request(app).post(`/api/projects/${slug}/generate/audio-merge`).send({
    episode_id: 'EP001',
    reuse_saved_settings: true,
    channel_intro: { enabled: true, file: introPath },
    write_mode: 'new',
    // These must not override the selected preset's mixer.
    gap_duration: 9, normalize_volume: false, narration_volume: 5,
    music: { enabled: false, files: [], volume: 50 },
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  const params = response.body.params
  assert.equal(params.gap_duration, 1, 'the selected preset gap wins over the request')
  assert.equal(params.normalize_volume, true)
  assert.equal(params.narration_volume, 0.8, '80% converted once, exactly as Pipeline does')
  assert.equal(params.music.volume, 0.12, '12% converted once; the request’s 50% is ignored')
  assert.equal(params.music.enabled, true)
  assert.equal(params.episode_id, 'EP001')
  assert.equal(params.write_mode, 'new')
  assert.equal(params.channel_intro.enabled, true)
  assert.notEqual(params.channel_intro.file, introPath, 'the intro bytes were frozen at the job boundary')
  assert.match(params.channel_intro.sha256, /^[a-f0-9]{64}$/)
  assert.equal(params.reuse_saved_settings, undefined)
})

test('channel_intro: null deliberately clears the intro while still using the saved mixer', async () => {
  const { slug } = await makeEpisode('clear')
  await saveMixerPreset(slug)
  const response = await request(app).post(`/api/projects/${slug}/generate/audio-merge`).send({
    episode_id: 'EP001',
    reuse_saved_settings: true,
    channel_intro: null,
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  const params = response.body.params
  assert.equal(params.gap_duration, 1)
  assert.equal(params.music.volume, 0.12)
  assert.equal('channel_intro' in params, false, 'a null clear leaves the legacy request unchanged')
})

test('the flag with no channel_intro key is refused, not defaulted', async () => {
  const { slug } = await makeEpisode('absent')
  await saveMixerPreset(slug)
  const response = await request(app).post(`/api/projects/${slug}/generate/audio-merge`).send({
    episode_id: 'EP001',
    reuse_saved_settings: true,
  })
  assert.equal(response.status, 400, JSON.stringify(response.body))
  assert.match(response.body.detail, /explicit channel intro choice/)
})

test('a malformed channel_intro selection is refused', async () => {
  const { slug } = await makeEpisode('malformed')
  await saveMixerPreset(slug)
  for (const file of ['   ', 42, { path: 'Intro.mp3' }]) {
    const response = await request(app).post(`/api/projects/${slug}/generate/audio-merge`).send({
      episode_id: 'EP001',
      reuse_saved_settings: true,
      channel_intro: { enabled: true, file },
    })
    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.match(response.body.detail, /malformed/)
  }
})

test('the flag with no selected preset is refused loudly', async () => {
  const { slug, introPath } = await makeEpisode('missing-preset')
  const response = await request(app).post(`/api/projects/${slug}/generate/audio-merge`).send({
    episode_id: 'EP001',
    reuse_saved_settings: true,
    channel_intro: { enabled: true, file: introPath },
  })
  assert.equal(response.status, 400, JSON.stringify(response.body))
  assert.match(response.body.detail, /No active preset for Audio Assembly/)
})
