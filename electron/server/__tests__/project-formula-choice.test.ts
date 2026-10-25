/**
 * "Chose Generic" and "never chose" must not be the same state (AGENTS §6).
 *
 * Owner ruling, 2026-10-25: a Formula is mandatory at channel creation, with an
 * explicit "Generic — no Formula" option. The wizard always sends the choice;
 * an older API client that sends neither leaves the field absent, which is the
 * state the in-app prompt exists for.
 */
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

async function app() {
  const { router: projectsRouter } = await import('../routes/projects.js')
  const { router: nichesRouter } = await import('../routes/niches.js')
  const instance = express()
  instance.use(express.json())
  instance.use('/api', projectsRouter)
  instance.use('/api', nichesRouter)
  return instance
}

test('the creation wizard can record a deliberate Generic choice', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const pm = await import('../services/project-manager.js')
  const api = await app()

  const generic = (await request(api).post('/api/projects').send({
    name: 'Generic test channel',
    formula_choice: 'generic',
  }).expect(201)).body
  const stored = await pm.getProject(generic.slug)
  assert.equal(stored?.formula_choice, 'generic')
  assert.equal(stored?.niche_id, undefined, 'Generic is the absence of a Formula, not a hidden one')

  const selected = (await request(api).post('/api/projects').send({
    name: 'Selected test channel',
    niche_id: 'history-narration',
  }).expect(201)).body
  const selectedStored = await pm.getProject(selected.slug)
  assert.equal(selectedStored?.formula_choice, 'selected')
  assert.equal(selectedStored?.niche_id, 'history-narration')
})

test('an older client that sends neither stays in the honest never-chose state', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const pm = await import('../services/project-manager.js')
  const api = await app()

  const created = (await request(api).post('/api/projects').send({ name: 'Never chose' }).expect(201)).body
  const stored = await pm.getProject(created.slug)
  assert.equal(stored?.formula_choice, undefined)
  assert.equal(stored?.niche_id, undefined)
})

test('the in-app prompt can choose a Formula or settle on Generic, and clearing returns to never-chose', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const pm = await import('../services/project-manager.js')
  const api = await app()
  const created = (await request(api).post('/api/projects').send({ name: 'Prompt channel' }).expect(201)).body

  await request(api).put(`/api/projects/${created.slug}/niche`)
    .send({ niche_id: 'psychology' })
    .expect(200)
  assert.equal((await pm.getProject(created.slug))?.formula_choice, 'selected')

  await request(api).put(`/api/projects/${created.slug}/niche`)
    .send({ niche_id: null, formula_choice: 'generic' })
    .expect(200)
  const generic = await pm.getProject(created.slug)
  assert.equal(generic?.formula_choice, 'generic')
  assert.equal(generic?.niche_id, undefined)

  // Clearing a Formula without claiming Generic is not a choice; the prompt
  // must be free to ask again.
  await request(api).put(`/api/projects/${created.slug}/niche`)
    .send({ niche_id: 'psychology' })
    .expect(200)
  await request(api).put(`/api/projects/${created.slug}/niche`)
    .send({ niche_id: null })
    .expect(200)
  const cleared = await pm.getProject(created.slug)
  assert.equal(cleared?.formula_choice, undefined)
  assert.equal(cleared?.niche_id, undefined)
})
