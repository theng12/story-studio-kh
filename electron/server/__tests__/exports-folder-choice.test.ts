/**
 * v1.4.249 — the finished-videos folder is choosable again.
 *
 * The owner: *"where finished videos go — no pick, it's a long text path to
 * type."* Choosing a folder must be safe in the one way that matters: a video
 * rendered before the change stays where it is and is STILL FOUND, so no
 * finished episode starts looking unfinished.
 */

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> } | undefined

beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

async function setup() {
  const lib = await import('../services/library.js')
  const pm = await import('../services/project-manager.js')
  const store = await import('../services/external-video-store.js')
  const library = path.join(tmp!.dir, 'Library')
  await lib.setLibraryRoot(library)
  const project = await pm.createProject({ name: 'Exports Choice' })
  return { lib, store, library, slug: project.slug }
}

test('default is <Library>/Exports and is not marked custom', async () => {
  const { lib, library } = await setup()
  const status = await lib.describeLibrary()
  assert.equal(status.exports_dir, path.join(library, 'Exports'))
  assert.equal(status.exports_custom, false)
  assert.deepEqual(status.exports_previous, [])
})

test('choosing a folder sends new renders there and remembers the old one', async () => {
  const { lib, store, library, slug } = await setup()
  const chosen = path.join(tmp!.dir, 'Finished videos')
  const status = await lib.setExportsRoot(chosen)
  assert.equal(status.exports_dir, chosen)
  assert.equal(status.exports_custom, true)
  assert.deepEqual(status.exports_previous, [path.join(library, 'Exports')])
  const writeDir = await store.ensureExternalFinalVideoDir(slug, 'EP0001', 'First')
  assert.ok(writeDir?.startsWith(chosen + path.sep), `new render goes to the chosen folder: ${writeDir}`)
})

test('a video rendered before the change is still found in the old folder', async () => {
  const { lib, store, slug } = await setup()
  const oldDir = await store.ensureExternalFinalVideoDir(slug, 'EP0002', 'Second')
  assert.ok(oldDir)
  await fs.writeFile(path.join(oldDir!, 'EP0002_final_video.mp4'), 'video')
  await lib.setExportsRoot(path.join(tmp!.dir, 'Elsewhere'))
  const found = await store.resolveExternalFinalVideoDir(slug, 'EP0002', 'Second')
  assert.equal(found, oldDir, 'existing finished video must still resolve to where it is')
  // An episode with nothing anywhere resolves to the NEW folder.
  const fresh = await store.resolveExternalFinalVideoDir(slug, 'EP0003', 'Third')
  assert.ok(fresh?.startsWith(path.join(tmp!.dir, 'Elsewhere')), String(fresh))
  // A re-render never writes back into the old folder.
  const rewrite = await store.ensureExternalFinalVideoDir(slug, 'EP0002', 'Second')
  assert.ok(rewrite?.startsWith(path.join(tmp!.dir, 'Elsewhere')), String(rewrite))
})

test('empty path returns to the Library Exports folder; history keeps the custom one', async () => {
  const { lib, library } = await setup()
  const chosen = path.join(tmp!.dir, 'Custom')
  await lib.setExportsRoot(chosen)
  const back = await lib.setExportsRoot('')
  assert.equal(back.exports_dir, path.join(library, 'Exports'))
  assert.equal(back.exports_custom, false)
  assert.deepEqual(back.exports_previous, [chosen], 'the Library Exports folder is current, so only the custom one is history')
})

test('the Library itself, or a folder holding it, is refused', async () => {
  const { lib, library } = await setup()
  await assert.rejects(lib.setExportsRoot(library), /holds your Library/)
  await assert.rejects(lib.setExportsRoot(tmp!.dir), /holds your Library/)
  const status = await lib.describeLibrary()
  assert.equal(status.exports_custom, false, 'a refused choice changes nothing')
})

test('PUT /library/exports sets and reports the folder', async () => {
  await setup()
  const request = (await import('supertest')).default
  const { app } = await import('../app.js')
  const chosen = path.join(tmp!.dir, 'Via route')
  const res = await request(app).put('/api/library/exports').send({ path: chosen })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.exports_dir, chosen)
  const read = await request(app).get('/api/app-settings/external-final-video-root')
  assert.equal(read.body.value, chosen)
  assert.equal(read.body.custom, true)
  const bad = await request(app).put('/api/library/exports').send({ path: 'relative/path' })
  assert.equal(bad.status, 400)
})
