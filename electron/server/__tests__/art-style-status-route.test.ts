/**
 * `GET /api/projects/:slug/settings/art-style` — what this channel's images
 * will actually use.
 *
 * The Settings screen used to decide this for itself (and got the alias case
 * wrong): a channel saved against one of the owner's presets that the Store now
 * owns rendered with the preset's OLD prose whenever the adopting pack was not
 * installed, and the screen said the channel was simply "saved against" a style
 * nothing provided. The screen now renders the resolver's own answer, so this
 * route is the contract to pin.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let app: express.Express
let tmp: { dir: string; cleanup: () => Promise<void> }

describe('art style status route', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    const { router } = await import('../routes/settings.js')
    app = express()
    app.use(express.json())
    app.use('/api', router)
  })

  after(async () => {
    await tmp.cleanup()
  })

  test('a plain saved preset reports what it uses and no fallback', async () => {
    const project = await pm.createProject({ name: 'Art Style Plain' })
    await pm.updateConfig(project.slug, {
      style_presets: [{
        id: 'wd', name: 'Whiteboard Doodle', description: 'Thick black marker outlines.',
        created_at: '2026-10-01T00:00:00Z',
      }],
      active_style_preset_id: 'wd',
    } as any)

    const response = await request(app).get(`/api/projects/${project.slug}/settings/art-style`).expect(200)
    assert.equal(response.body.requestedId, 'wd')
    assert.deepEqual(response.body.applied, { id: 'wd', name: 'Whiteboard Doodle' })
    assert.equal(response.body.fallback, null)
  })

  test('an aliased preset whose Store pack is not installed names the style and what ran instead', async () => {
    const project = await pm.createProject({ name: 'Art Style Aliased' })
    await pm.updateConfig(project.slug, {
      style_presets: [{
        id: 'night-atlas-woodcut', name: 'Night Atlas — Woodcut',
        description: 'Woodcut and linocut print, bold carved lines.',
        created_at: '2026-10-10T00:00:00Z',
      }],
      active_style_preset_id: 'night-atlas-woodcut',
    } as any)

    const response = await request(app).get(`/api/projects/${project.slug}/settings/art-style`).expect(200)
    assert.equal(response.body.fallback.reason, 'store_style_not_installed')
    assert.equal(response.body.fallback.requestedId, 'night-atlas-woodcut')
    assert.equal(response.body.fallback.requestedName, 'Night Atlas — Woodcut')
    assert.equal(response.body.fallback.storeStyleId, 'com.storystudio.style.carved-woodcut-print')
    assert.equal(response.body.fallback.used, 'saved_preset')
    assert.equal(response.body.fallback.usedName, 'Night Atlas — Woodcut')
    assert.match(response.body.fallback.message, /not installed on this Mac/)
    // What still runs is the channel's own text, not nothing.
    assert.equal(response.body.applied.id, 'night-atlas-woodcut')
  })

  test('an id that resolves to nothing says the format default will be used', async () => {
    const project = await pm.createProject({ name: 'Art Style Dangling' })
    await pm.updateConfig(project.slug, { active_style_preset_id: 'com.storystudio.style.gone' } as any)

    const response = await request(app).get(`/api/projects/${project.slug}/settings/art-style`).expect(200)
    assert.equal(response.body.requestedId, 'com.storystudio.style.gone')
    assert.equal(response.body.applied, null)
    assert.equal(response.body.fallback.reason, 'style_not_found')
    assert.equal(response.body.fallback.used, 'format_default')
    assert.match(response.body.fallback.message, /format default style/)
  })

  test('a channel with no style at all is not a fallback', async () => {
    const project = await pm.createProject({ name: 'Art Style None' })
    const response = await request(app).get(`/api/projects/${project.slug}/settings/art-style`).expect(200)
    assert.equal(response.body.requestedId, '')
    assert.equal(response.body.applied, null)
    assert.equal(response.body.fallback, null)
  })

  test('an unknown project is a 404, not an empty answer', async () => {
    await request(app).get('/api/projects/no-such-project/settings/art-style').expect(404)
  })
})
