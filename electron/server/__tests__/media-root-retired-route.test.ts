import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: express.Express
let pm: typeof import('../services/project-manager.js')

const readMeta = async (slug: string) =>
  JSON.parse(await fs.readFile(path.join(pm.getProjectDir(slug)!, 'project.json'), 'utf8'))

// v1.4.249 — "heavy media on another drive" is retired for projects that do not
// use it. A project that already has media_root keeps it and may change or clear
// it; a project without one cannot start.
describe('PUT /api/projects/:slug media_root (retired for projects without it)', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    const { router } = await import('../routes/projects.js')
    app = express()
    app.use(express.json())
    app.use('/api', router)
  })
  after(async () => { await tmp.cleanup() })

  test('a project without media_root cannot start using one, and project.json is not rewritten', async () => {
    const p = await pm.createProject({ name: 'No Split' })
    const before = await fs.readFile(path.join(pm.getProjectDir(p.slug)!, 'project.json'), 'utf8')
    const res = await request(app).put(`/api/projects/${p.slug}`).send({ media_root: '/Volumes/Other/Media' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /^Heavy media on another drive is retired: it can only be changed or cleared on a project that already uses it\.$/)
    assert.equal(await fs.readFile(path.join(pm.getProjectDir(p.slug)!, 'project.json'), 'utf8'), before)
    // Sending an empty value (nothing to start) and other fields still work.
    const ok = await request(app).put(`/api/projects/${p.slug}`).send({ media_root: '', name: 'Renamed' })
    assert.equal(ok.status, 200)
    assert.equal((await readMeta(p.slug)).name, 'Renamed')
  })

  test('a project that has media_root can change it and clear it', async () => {
    const p = await pm.createProject({ name: 'Has Split' })
    const metaPath = path.join(pm.getProjectDir(p.slug)!, 'project.json')
    await fs.writeFile(metaPath, JSON.stringify({ ...(await readMeta(p.slug)), media_root: '/Volumes/Old/Media' }))

    const changed = await request(app).put(`/api/projects/${p.slug}`).send({ media_root: '/Volumes/New/Media' })
    assert.equal(changed.status, 200)
    assert.equal((await readMeta(p.slug)).media_root, '/Volumes/New/Media')

    const cleared = await request(app).put(`/api/projects/${p.slug}`).send({ media_root: '' })
    assert.equal(cleared.status, 200)
    assert.equal((await readMeta(p.slug)).media_root, '')

    // Once cleared, it is a project without one.
    const again = await request(app).put(`/api/projects/${p.slug}`).send({ media_root: '/Volumes/New/Media' })
    assert.equal(again.status, 400)
  })
})
