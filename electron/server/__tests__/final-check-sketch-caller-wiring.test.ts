/**
 * The caller's Sketch Draw scene data reaches the final check.
 *
 * The Upload Center check builds its expectation from whatever the file recorded, or from the
 * episode's own Scene Plan for an older final. This proves that second path carries the plan's
 * actual scene timing and clip receipts through to the measurement as `scene_blank_starts` — the
 * helper being correct is not useful if its caller never asks it.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { tinyVideoWithSoundBytes as tinyVideoBytes } from './fixtures/tiny-video.js'
import { finalCheckProgress, __setFinalCheckRunnerForTests } from '../lib/final-video-check.js'

const boot = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const utils = await import('../services/utils.js')
const im = await import('../services/idea-manager.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  __setFinalCheckRunnerForTests(null)
  await cleanup?.()
  cleanup = undefined
})

test('the final check measures against the episode plan\'s Sketch Draw blank starts', async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const slug = (await pm.createProject({ name: 'Sketch caller' })).slug
  const title = 'The Lighthouse at Dawn'
  const [idea] = await im.addIdeas(slug, [{
    title, logline: 'A keeper counts the nights.', themes: ['solitude'],
    suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const episodeCode = (await im.acceptIdea(slug, idea!.id)).idea.episode_code!
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({ title, description: 'D.', tags: ['x'] }))
  const videoPath = path.join(paths.video_dir, `${episodeCode}_final_video.mp4`)
  await fs.writeFile(videoPath, tinyVideoBytes())

  // The plan the final was made for: scene 2 drew for 150 of its 300 frames at 30 fps.
  const planPath = await utils.resolveScenePlanPath(slug, episodeCode, paths.episode_dir)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, JSON.stringify({
    source_merged_audio: { duration_sec: 30 },
    scenes: [
      { id: 'scene-1', start_sec: 0, end_sec: 10 },
      { id: 'scene-2', start_sec: 10, end_sec: 20, clip_renderer: 'sketch_draw', clip_sketch: { fps: 30, frames: 300, hold_frames: 150 } },
    ],
  }))

  let measured: any = null
  __setFinalCheckRunnerForTests(async (file, expected) => {
    measured = expected
    const stat = await fs.stat(file)
    return {
      checked_at: new Date().toISOString(), file: { size: stat.size, mtime_ms: stat.mtimeMs },
      passed: true, issues: [], expected,
      actual: { duration_sec: 20, video_sec: 20, audio_sec: 20, width: 0, height: 0, tail_lufs: null, black: [], silence: [] },
    } as any
  })

  const res = await request(app).post(`/api/projects/${slug}/youtube/final-check`)
    .send({ episode_code: episodeCode })
  assert.equal(res.status, 202, JSON.stringify(res.body))
  await waitFor(() => measured !== null, { label: 'the final check to start measuring' })

  assert.equal(measured.speech_end_sec, 30)
  // The two 10 s scenes sit 10 s before that speech end, so scene 2 begins at 0:20.
  assert.deepEqual(measured.scene_blank_starts, [{ scene_id: 'scene-2', start_sec: 20, end_sec: 25 }])
  await waitFor(() => !finalCheckProgress(videoPath).running, { label: 'the check to store its verdict' })
})
