/**
 * 1.4.276 — Coffee Jazz: "New episode" in Episode Builder handed out the
 * recycled gaps CJ0001–CJ0005 while the channel was at CJ0027. New episodes
 * now continue after the highest code; only an explicit override_code goes lower.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: any
let slug = ''

before(async () => {
  tmp = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Coffee Jazz', episode_prefix: 'CJ', episode_digits: 4 } as any)
  slug = project.slug
  const codes = Array.from({ length: 22 }, (_, i) => i + 6) // CJ0006..CJ0027; CJ0001–CJ0005 are gaps
  await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'ideas.json'), JSON.stringify({
    ideas: codes.map(n => ({ id: `idea-${n}`, title: `Mix ${n}`, status: 'accepted', episode_code: `CJ${String(n).padStart(4, '0')}` })),
    next_episode_number: 28, recycled_numbers: [1, 2, 3, 4, 5],
  }))
})
after(async () => { await tmp.cleanup() })

test('a new Episode Builder episode after CJ0027 is CJ0028, then CJ0029, even with gaps below', async () => {
  const first = await request(app).post(`/api/projects/${slug}/music-episodes`).send({ title: 'Rainy Window Jazz' })
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(first.body.code, 'CJ0028')
  const second = await request(app).post(`/api/projects/${slug}/music-episodes`).send({ title: 'Late Night Espresso' })
  assert.equal(second.body.code, 'CJ0029')
})

test('an explicit override_code may still use a free lower code', async () => {
  const res = await request(app).post(`/api/projects/${slug}/music-episodes`).send({ title: 'Morning Brew', override_code: 'CJ0003' })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  assert.equal(res.body.code, 'CJ0003')
})
