/**
 * Motion Review sets the episode's motion scope for Sketch Draw itself (owner, 2026-10-24): Sketch Draw
 * needs no motion prompts, so it is not bound to Scene Plan. The save moves ONLY motion_scope — the
 * rhythm and every other field in continuity.json stay exactly as they were (AGENTS §5 save boundary).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: express.Express
let pm: typeof import('../services/project-manager.js')
let paths: typeof import('../services/utils.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  paths = await import('../services/utils.js')
  const { router } = await import('../routes/scene-review.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)
})
after(async () => { await cleanup() })

async function episode(name: string) {
  const project = await pm.createProject({ name })
  const resolved = await paths.resolveEpisodePathsByCode(project.slug, 'EP001')
  await fs.mkdir(resolved.episode_dir, { recursive: true })
  return { slug: project.slug, file: path.join(resolved.episode_dir, 'continuity.json') }
}
const put = (slug: string, motion_scope: unknown, code = 'EP001') =>
  request(app).put(`/api/projects/${slug}/scene-review/${code}/motion-scope`).send({ motion_scope })

test('saving the scope changes only motion_scope; the rhythm and every other field are kept', async () => {
  const { slug, file } = await episode('Scope keeps rhythm')
  const stored = {
    schema_version: 1, anchor_character_ids: ['c1'], use_episode_sheet: false,
    pacing: { min_sec: 20, max_sec: 30 }, motion_scope: { mode: 'off' }, motion_level: 3,
    references: { prev_render: true, sheet: false, characters: true, style: false, composition: false },
    denoise_strength: 0.4, style_bible: 'ink', negative_prompt: '', updated_at: '2026-10-01T00:00:00.000Z',
  }
  await fs.writeFile(file, JSON.stringify(stored))
  const res = await put(slug, { mode: 'all' }).expect(200)
  assert.deepEqual(res.body.motion_scope, { mode: 'all' })
  const after = JSON.parse(await fs.readFile(file, 'utf8'))
  const { motion_scope, updated_at, ...rest } = after
  const { motion_scope: _m, updated_at: _u, ...was } = stored
  assert.deepEqual(motion_scope, { mode: 'all' })
  assert.deepEqual(rest, was, 'nothing but the scope moved')
  assert.notEqual(updated_at, stored.updated_at)

  await put(slug, { mode: 'opening', end_sec: 45 }).expect(200)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).motion_scope, { mode: 'opening', end_sec: 45 })
})

test('an episode with no continuity file yet gets the defaults plus the chosen scope', async () => {
  const { slug, file } = await episode('Scope fresh')
  await put(slug, { mode: 'all' }).expect(200)
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.deepEqual(saved.motion_scope, { mode: 'all' })
  assert.equal(saved.schema_version, 1)
})

test('a bad scope, a bad episode id, or an unreadable file is refused and nothing is written', async () => {
  const { slug, file } = await episode('Scope refusals')
  assert.match((await put(slug, { mode: 'opening', end_sec: -1 }).expect(400)).body.detail, /\S/)
  await assert.rejects(fs.access(file), 'a refused scope writes no file')
  await put(slug, { mode: 'all' }, '..%2Fx').expect(400)
  await fs.writeFile(file, '{ not json')
  assert.match((await put(slug, { mode: 'all' }).expect(409)).body.detail, /malformed/)
  assert.equal(await fs.readFile(file, 'utf8'), '{ not json', 'the unreadable file is left as it was')
})
