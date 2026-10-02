/**
 * The Music Library's "Build the video" takes a typed episode code. A typo used to queue a render
 * that created a stray `<code> - ` folder; the route now refuses codes the project does not have.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

void test('Build the video refuses an episode code the project does not have', async () => {
  const isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const app = (await import('../app.js')).app
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Music video fixture', episode_prefix: 'EP', episode_digits: 4 })
    const background = path.join(pm.getProjectDir(project.slug)!, 'bg.png')
    await fs.writeFile(background, 'x')
    const res = await request(app).post(`/api/projects/${project.slug}/music-library/render`)
      .send({ episode_id: 'EP9999', background_path: background, target_seconds: 600 })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /no episode EP9999/)
    const jq = await import('../services/job-queue.js')
    assert.ok(!(await jq.getJobs(project.slug)).some(job => job.type === 'music_video'))
  } finally {
    await isolated.cleanup()
  }
})
