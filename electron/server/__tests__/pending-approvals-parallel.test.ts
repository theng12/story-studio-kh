import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let utils: typeof import('../services/utils.js')
let resolveSceneImagesDir: typeof import('../generators/scene-image.js')['resolveSceneImagesDir']
let app: express.Express

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  utils = await import('../services/utils.js')
  ;({ resolveSceneImagesDir } = await import('../generators/scene-image.js'))
  const { router } = await import('../routes/pipeline.js')
  const projects = await import('../routes/projects.js')
  app = express().use(express.json()).use('/api', router).use('/api', projects.router)
})
after(async () => { await cleanup() })

// S8: the per-episode reads now run 8 at a time with one facts cache; the answer must not change.
test('pending-approvals and chunked-sidecars keep their results and episode order when read in parallel', async () => {
  const project = await pm.createProject({ name: 'Pending Parallel' })
  const count = 12
  const ideas = await im.addIdeas(project.slug, Array.from({ length: count }, (_, i) => ({
    title: `Story ${i + 1}`, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  })), 'test')
  for (const [i, idea] of ideas.entries()) {
    await im.acceptIdea(project.slug, idea.id, false, { override_code: `EP${String(i + 1).padStart(4, '0')}` })
  }
  const expected: Array<{ episode_id: string; approved: number; with_image: number }> = []
  for (let i = 0; i < count; i++) {
    const code = `EP${String(i + 1).padStart(4, '0')}`
    const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    // Every third episode is fully approved; every fourth has no images; the rest have some.
    const scenes = [1, 2, 3].map(n => ({ id: `s${n}`, scene_index: n, start_sec: n, end_sec: n + 1, visual_prompt: 'p', approved: i % 3 === 0 || n === 1 }))
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes }))
    await fs.mkdir(paths.script_dir, { recursive: true })
    await fs.writeFile(path.join(paths.script_dir, `${code}_chunked-progress.json`), '{}')
    if (i % 4 === 1) continue
    const imagesDir = await resolveSceneImagesDir(project.slug, code, paths.episode_dir)
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.writeFile(path.join(imagesDir, 's1.png'), 'x')
    await fs.writeFile(path.join(imagesDir, 's2.png'), 'x')
    if (i % 3 !== 0) expected.push({ episode_id: code, approved: 1, with_image: 2 })
  }
  const res = await request(app).get(`/api/projects/${project.slug}/pipeline/pending-approvals`).expect(200)
  assert.deepEqual(res.body.pending.map(({ episode_id, approved, with_image }: any) => ({ episode_id, approved, with_image })), expected)
  assert.ok(res.body.pending.every((row: any) => row.total === 3 && /^Story /.test(row.title)))

  const sidecars = await request(app).get(`/api/projects/${project.slug}/storage/chunked-sidecars`).expect(200)
  assert.deepEqual(sidecars.body.episodes.map((e: any) => e.episode_code),
    Array.from({ length: count }, (_, i) => `EP${String(i + 1).padStart(4, '0')}`))
  assert.ok(sidecars.body.episodes.every((e: any) => e.sidecar_present === true))
})
