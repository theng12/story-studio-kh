/**
 * Channel Characters: a reference image can be removed (record + file), and
 * the role (archetype) can be cleared with '' while undefined keeps it.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let cl: typeof import('../services/character-library.js')
let app: express.Express
const SLUG = 'ref-edit-channel'

before(async () => {
  tmp = await useTempDataDir()
  cl = await import('../services/character-library.js')
  const route = await import('../routes/characters.js')
  app = express()
  app.use(express.json())
  app.use('/api', route.router)
})

after(async () => { await tmp?.cleanup() })

test('DELETE reference image removes it from the record and disk; the next one becomes the portrait', async () => {
  const c = await cl.createChannelCharacter(SLUG, { name: 'Ref Guide', description: 'd' })
  await cl.addChannelReferenceImage(SLUG, c.id, Buffer.from('a'), 'one.png')
  await cl.addChannelReferenceImage(SLUG, c.id, Buffer.from('b'), 'two.png')
  const res = await request(app).delete(`/api/projects/${SLUG}/characters/${c.id}/reference-image/one.png`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.references.images, ['two.png'])
  assert.equal(existsSync(path.join(cl.channelCharacterDir(SLUG, c.id), 'one.png')), false)
  assert.equal(existsSync(path.join(cl.channelCharacterDir(SLUG, c.id), 'two.png')), true)
  // Never hard-deleted: the removed picture is kept in Story's Trash.
  const { projectsRoot } = await import('../services/project-manager.js')
  assert.equal(existsSync(path.join(projectsRoot(), '_trash', '_character-library', SLUG, c.id, 'one.png')), true)
  assert.equal((await cl.listChannelCharacters(SLUG)).length, 1)

  const missing = await request(app).delete(`/api/projects/${SLUG}/characters/${c.id}/reference-image/nope.png`)
  assert.equal(missing.status, 404)
  const escape = await request(app).delete(`/api/projects/${SLUG}/characters/${c.id}/reference-image/..%2Fx.png`)
  assert.equal(escape.status, 404)
})

test("archetype '' clears the role; undefined keeps it", async () => {
  const c = await cl.createChannelCharacter(SLUG, { name: 'Role Guide', description: 'd', archetype: 'mentor' })
  assert.equal((await cl.updateChannelCharacter(SLUG, c.id, { description: 'd2' }))?.archetype, 'mentor')
  assert.equal((await cl.updateChannelCharacter(SLUG, c.id, { archetype: '' }))?.archetype, undefined)
})
