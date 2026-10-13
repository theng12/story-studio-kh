import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let app: any
let temp: Awaited<ReturnType<typeof useTempDataDir>>

before(async () => {
  temp = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
})

after(async () => { await temp.cleanup() })

test('manual generation redo defaults off and survives reload without changing paid replacement settings', async () => {
  const initial = await request(app).get('/api/app-settings/manual-generation-redo')
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.body, { enabled: false })

  const paidBefore = await request(app).get('/api/app-settings/paid-replacements')
  const saved = await request(app).put('/api/app-settings/manual-generation-redo').send({ enabled: true })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body, { enabled: true })
  assert.deepEqual((await request(app).get('/api/app-settings/manual-generation-redo')).body, { enabled: true })
  assert.deepEqual((await request(app).get('/api/app-settings/paid-replacements')).body, paidBefore.body)
})

test('manual generation redo rejects malformed writes without changing the prior value and corrupt storage fails closed', async () => {
  for (const body of [{}, { enabled: 'yes' }, { enabled: false, extra: true }, null]) {
    const pending = request(app).put('/api/app-settings/manual-generation-redo')
    const response = body === null ? await pending.type('json').send('null') : await pending.send(body)
    assert.equal(response.status, 400, JSON.stringify(body))
  }
  assert.deepEqual((await request(app).get('/api/app-settings/manual-generation-redo')).body, { enabled: true })

  const target = path.join(temp.dir, 'app-settings.json')
  const stored = JSON.parse(await fs.readFile(target, 'utf8'))
  stored.manual_generation_redo = { enabled: 'corrupt' }
  await fs.writeFile(target, JSON.stringify(stored))
  assert.deepEqual((await request(app).get('/api/app-settings/manual-generation-redo')).body, { enabled: false })
})
