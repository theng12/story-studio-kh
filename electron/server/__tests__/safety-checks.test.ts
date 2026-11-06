/**
 * 1.4.300 — Safety checks: one Off / Warn / Block switch per check, per channel (owner 2026-10-12:
 * "same application of control please"; loudness: "Yes, turn it off"). Plus the two gaps the
 * inventory found: a silent merged narration and a video with no sound now stop by default.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let temp: { dir: string; cleanup: () => Promise<void> }
let app: express.Express
let slug = ''

before(async () => {
  temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  slug = (await pm.createProject({ name: 'Safety Checks', episode_prefix: 'EP', episode_digits: 4 })).slug
  const { router } = await import('../routes/settings.js')
  app = express()
  app.use(express.json())
  app.use(router)
})
after(async () => { await temp.cleanup() })

const job = () => ({ output_lines: [] as string[], result: undefined as Record<string, any> | undefined })

test('every check has a default; loudness is Off, broken output is Block, and the page saves per channel', async () => {
  const { SAFETY_CHECKS } = await import('../services/safety-checks.js')
  assert.equal(new Set(SAFETY_CHECKS.map(check => check.id)).size, SAFETY_CHECKS.length)
  const list = (await request(app).get(`/projects/${slug}/safety-checks`).expect(200)).body.checks
  const mode = (id: string) => list.find((check: any) => check.id === id)?.mode
  assert.equal(mode('loudness'), 'off')
  for (const id of ['silent_narration', 'merged_audio_exists', 'valid_video', 'private_upload', 'right_channel']) assert.equal(mode(id), 'block', id)
  assert.ok(list.find((check: any) => check.id === 'gateway_key').locked_reason)
  // 1.4.301 — owner: "No upload without a thumbnail"; the paid remake says it costs money.
  assert.equal(mode('thumbnail_present'), 'block')
  assert.match(list.find((check: any) => check.id === 'retired_media').protects, /costs money/)

  await request(app).put(`/projects/${slug}/safety-checks`).send({ modes: { loudness: 'block', caption_gap: 'off' } }).expect(200)
  await request(app).put(`/projects/${slug}/safety-checks`).send({ modes: { gateway_key: 'off' } }).expect(400)
  await request(app).put(`/projects/${slug}/safety-checks`).send({ modes: { loudness: 'maybe' } }).expect(400)
  const after = (await request(app).get(`/projects/${slug}/safety-checks`).expect(200)).body.checks
  assert.equal(after.find((check: any) => check.id === 'loudness').mode, 'block')
  assert.equal(after.find((check: any) => check.id === 'caption_gap').mode, 'off')

  const all = (await request(app).post('/safety-checks/apply-to-all').send({ modes: { loudness: 'off' } }).expect(200)).body
  assert.ok(all.applied.includes(slug))
  const { safetyMode } = await import('../services/safety-checks.js')
  assert.equal(await safetyMode(slug, 'loudness'), 'off')
})

test('silence tolerance defaults to ten, persists per channel, and is used fresh by checks', async () => {
  const pm = await import('../services/project-manager.js')
  const { finalCheckOptionsFor } = await import('../lib/final-video-check.js')
  const other = (await pm.createProject({ name: 'Other Silence Channel' })).slug
  assert.equal((await request(app).get(`/projects/${slug}/safety-checks`).expect(200)).body.silence_min_sec, 10)
  await request(app).put(`/projects/${slug}/safety-checks`).send({ silence_min_sec: 15 }).expect(200)
  assert.equal((await request(app).get(`/projects/${slug}/safety-checks`).expect(200)).body.silence_min_sec, 15)
  assert.deepEqual(await finalCheckOptionsFor(slug), { silence_min_sec: 15 })
  assert.deepEqual(await finalCheckOptionsFor(other), {})
  await request(app).put(`/projects/${slug}/safety-checks`).send({ silence_min_sec: 20 }).expect(200)
  assert.deepEqual(await finalCheckOptionsFor(slug), { silence_min_sec: 20 })
  for (const bad of [0, 301, null, true, 'bad']) {
    await request(app).put(`/projects/${slug}/safety-checks`).send({ silence_min_sec: bad }).expect(400)
    assert.deepEqual(await finalCheckOptionsFor(slug), { silence_min_sec: 20 })
  }
  await request(app).post('/safety-checks/apply-to-all').send({ silence_min_sec: 12 }).expect(200)
  assert.deepEqual(await finalCheckOptionsFor(other), { silence_min_sec: 12 })
  await request(app).put(`/projects/${slug}/safety-checks`).send({ silence_min_sec: 10 }).expect(200)
  assert.deepEqual(await finalCheckOptionsFor(slug), { silence_min_sec: 10 })
})

test('a failed check stops on Block, and carries on with a log line (Off) or a job warning (Warn)', async () => {
  const { safetyGate } = await import('../services/safety-checks.js')
  const { isNonRetryableError } = await import('../services/job-retry-policy.js')
  await request(app).put(`/projects/${slug}/safety-checks`).send({ modes: { intro_audio: 'block' } }).expect(200)
  const blocked = await safetyGate(slug, 'intro_audio', job(), 'The intro is missing.').catch(error => error)
  assert.ok(blocked instanceof Error && isNonRetryableError(blocked))

  await request(app).put(`/projects/${slug}/safety-checks`).send({ modes: { intro_audio: 'warn' } }).expect(200)
  const warned = job()
  assert.equal(await safetyGate(slug, 'intro_audio', warned, 'The intro is missing.'), 'warn')
  assert.match(warned.output_lines[0]!, /^⚠ The intro is missing\. .*set to Warn/)
  assert.deepEqual(warned.result?.safety_warnings, [{ check: 'intro_audio', message: 'The intro is missing.' }])

  await request(app).put(`/projects/${slug}/safety-checks`).send({ modes: { intro_audio: 'off' } }).expect(200)
  const off = job()
  assert.equal(await safetyGate(slug, 'intro_audio', off, 'The intro is missing.'), 'off')
  assert.equal(off.result, undefined)
})

test('loudness Off keeps a final outside the allowance; Block still stops it; an unreadable level always stops', async () => {
  const { verifyFinalLoudness } = await import('../generators/video.js')
  const { loudnessTarget } = await import('../lib/final-loudness.js')
  const quiet = path.join(temp.dir, 'quiet.m4a')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-af', 'volume=0.02', '-c:a', 'aac', quiet])
  const off = job() as any
  await verifyFinalLoudness(off, quiet, { ...loudnessTarget({}), check: 'off' })
  assert.ok(off.output_lines.some((line: string) => /loudness check is Off/.test(line)), off.output_lines.join('\n'))
  await assert.rejects(verifyFinalLoudness(job() as any, quiet, { ...loudnessTarget({}), check: 'block' }), /not at its target level/)
  const silent = path.join(temp.dir, 'silent.m4a')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '3', '-c:a', 'aac', silent])
  await assert.rejects(verifyFinalLoudness(job() as any, silent, { ...loudnessTarget({}), check: 'off' }), /not at its target level/)
})

test('a silent merged narration stops Audio Assembly by default (it used to carry on to Video Assembly)', async () => {
  const { levelMergedAudio } = await import('../generators/audio-merge.js')
  const { loudnessTarget } = await import('../lib/final-loudness.js')
  const raw = path.join(temp.dir, 'silent-raw.flac')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3', '-c:a', 'flac', raw])
  const out = (name: string) => ({ master: path.join(temp.dir, `${name}.flac`), mp3: path.join(temp.dir, `${name}.mp3`) })
  await assert.rejects(
    levelMergedAudio({ raw, ...out('a'), loudness: loudnessTarget({}), tempDir: temp.dir, lines: [], slug }),
    /merged narration is silent/,
  )
  await request(app).put(`/projects/${slug}/safety-checks`).send({ modes: { silent_narration: 'off' } }).expect(200)
  const lines: string[] = []
  await levelMergedAudio({ raw, ...out('b'), loudness: loudnessTarget({}), tempDir: temp.dir, lines, slug })
  assert.ok(lines.some(line => /merged narration is silent.*carries on/.test(line)), lines.join('\n'))
})
