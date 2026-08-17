/**
 * The subtitle preview, rendered for real.
 *
 * The Verified Completion Contract is explicit that a function returning
 * without throwing is not evidence. Every other test in this area asserts on
 * strings; this one runs the actual endpoint, lets FFmpeg burn the actual ASS
 * document, and then asks `ffprobe` what came out. A preview that silently
 * produced a 0-byte file, or a 1.5-second clip when it promised 4, or a clip
 * with no video stream, would pass every string assertion in the suite.
 *
 * Skipped — not failed — when the FFmpeg build has no libass. The check is a
 * real capability probe, so a machine that cannot burn subtitles says so
 * instead of reporting a defect that is not there.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { useTempDataDir } from './_helpers.js'
import { hasLibass } from '../lib/ffmpeg-utils.js'
import { getFFprobePath } from '../services/ffmpeg-manager.js'
import { setAppSetting } from '../services/app-settings.js'
import { cachedFileForToken } from '../services/preview-cache.js'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import { SUBTITLE_PREVIEW_W, SUBTITLE_PREVIEW_H } from '../contracts/subtitle-preview.js'
import { defaultSubtitleStyle, mergeSubtitleStyle } from '../contracts/subtitle-style.js'
import { router as videoRouter } from '../routes/video.js'

const execFileAsync = promisify(execFile)

const temp = await useTempDataDir()
after(async () => { await temp.cleanup() })

/**
 * Point FFmpeg at the binary the DMG actually ships.
 *
 * `getFFmpegPath()` finds the bundled build through `process.resourcesPath`,
 * which only exists under Electron — a bare test process falls through to
 * whatever `ffmpeg` is on PATH, and a Homebrew build frequently has no libass
 * at all (this developer's does not). Without this the test would skip
 * everywhere and prove nothing, while the shipped app burns subtitles fine.
 * Setting the saved path makes the test exercise the SAME binary the customer
 * gets.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
for (const binary of ['ffmpeg', 'ffprobe'] as const) {
  const bundled = path.join(repoRoot, 'bundled', 'ffmpeg', binary)
  if (existsSync(bundled)) await setAppSetting(`${binary}_path`, bundled)
}

function app() {
  const instance = express()
  instance.use(express.json({ limit: '1mb' }))
  instance.use('/api', videoRouter)
  return instance
}

/** Duration and stream shape, straight from ffprobe. */
async function probe(file: string): Promise<{ duration: number; width: number; height: number }> {
  const { stdout } = await execFileAsync(await getFFprobePath(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    file,
  ])
  const parsed = JSON.parse(stdout)
  return {
    duration: Number(parsed.format?.duration ?? 0),
    width: Number(parsed.streams?.[0]?.width ?? 0),
    height: Number(parsed.streams?.[0]?.height ?? 0),
  }
}

const libass = await hasLibass()

describe('subtitle preview renders a real clip', { skip: libass ? false : 'FFmpeg build has no libass' }, () => {
  test('POST returns a token whose clip is a real 4-second clip at the declared size', async () => {
    const res = await request(app())
      .post('/api/projects/preview-fixture/video-editor/preview-subtitles')
      .send({ style: defaultSubtitleStyle() })
      .expect(200)

    assert.match(res.body.token, /^[a-f0-9]{20}\.webm$/)
    assert.equal(res.body.duration_sec, 4, 'a word sweep cannot be judged in 1.5 seconds')
    assert.equal(res.body.word_precision, null, 'word mode is off in the default style')

    const file = cachedFileForToken(res.body.token)
    assert.ok(file, 'the token must resolve to a cached file')
    const stat = await fs.stat(file!)
    assert.ok(stat.size > 4_000, `a real clip, not an empty container — got ${stat.size} bytes`)

    // v1.3.2 — assert against the endpoint's own constant AND against what
    // the response claimed, rather than a literal this file keeps its own copy
    // of. The point of this test is that the bytes match the promise; a
    // restated number can only ever check the promise against itself.
    assert.equal(res.body.width, SUBTITLE_PREVIEW_W)
    assert.equal(res.body.height, SUBTITLE_PREVIEW_H)
    const info = await probe(file!)
    assert.equal(info.width, res.body.width)
    assert.equal(info.height, res.body.height)
    assert.ok(Math.abs(info.duration - 4) < 0.35, `expected ~4s, ffprobe says ${info.duration}s`)
  })

  test('GET streams the clip the POST produced', async () => {
    const post = await request(app())
      .post('/api/projects/preview-fixture/video-editor/preview-subtitles')
      .send({ style: defaultSubtitleStyle() })
      .expect(200)
    const res = await request(app())
      .get(`/api/projects/preview-fixture/video-editor/preview-subtitles?token=${post.body.token}`)
      .expect(200)
    assert.equal(res.headers['content-type'], 'video/webm')
    assert.ok(res.body.length > 4_000)
  })

  for (const id of ['karaoke-highlight', 'word-reveal']) {
    test(`${id} renders as a real clip and reports estimated word timing`, async () => {
      const preset = BUILT_IN_SUBTITLE_PRESETS.find(p => p.id === id)!
      const res = await request(app())
        .post('/api/projects/preview-fixture/video-editor/preview-subtitles')
        .send({ style: preset.style })
        .expect(200)
      assert.equal(res.body.word_precision, 'estimated', 'the app must not imply measured timing')

      const file = cachedFileForToken(res.body.token)
      assert.ok(file, `${id} produced no cached clip`)
      const stat = await fs.stat(file!)
      assert.ok(stat.size > 4_000, `${id}: ${stat.size} bytes is not a rendered clip`)
      const info = await probe(file!)
      assert.ok(Math.abs(info.duration - 4) < 0.35, `${id}: ffprobe says ${info.duration}s`)
    })
  }

  test('two different styles do not share a cache entry', async () => {
    // The cache key is the serialised style document, so a new field cannot be
    // forgotten and serve a stale frame — but only if that actually holds.
    const server = app()
    const a = await request(server)
      .post('/api/projects/preview-fixture/video-editor/preview-subtitles')
      .send({ style: defaultSubtitleStyle() }).expect(200)
    const b = await request(server)
      .post('/api/projects/preview-fixture/video-editor/preview-subtitles')
      .send({ style: mergeSubtitleStyle(defaultSubtitleStyle(), { color: { primary_hex: '#FF0000' } }) }).expect(200)
    assert.notEqual(a.body.token, b.body.token)
  })

  test('an unknown field is refused by name rather than previewed as something else', async () => {
    const res = await request(app())
      .post('/api/projects/preview-fixture/video-editor/preview-subtitles')
      .send({ style: { ...defaultSubtitleStyle(), sparkles: true } })
      .expect(400)
    assert.match(res.body.detail, /"sparkles"/)
  })

  test('an expired or invented token is a clean 404, never a path escape', async () => {
    const server = app()
    await request(server)
      .get('/api/projects/preview-fixture/video-editor/preview-subtitles?token=' + encodeURIComponent('../../../../etc/passwd'))
      .expect(404)
    await request(server)
      .get('/api/projects/preview-fixture/video-editor/preview-subtitles?token=0123456789abcdef0123.webm')
      .expect(404)
  })

  test('the legacy flat query shape still renders', async () => {
    // Anything already linking at this endpoint keeps working; it normalises
    // through the same path rather than a second implementation.
    const res = await request(app())
      .get('/api/projects/preview-fixture/video-editor/preview-subtitles?font_size_px=34&color_hex=%2300FF00&animation=fade')
      .expect(200)
    assert.equal(res.headers['content-type'], 'video/webm')
    assert.ok(res.body.length > 4_000)
  })
})
