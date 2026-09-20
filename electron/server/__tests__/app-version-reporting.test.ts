import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { after, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const isolated = await useTempDataDir()
after(async () => {
  const { isBootComplete } = await import('../boot/migrations.js')
  await waitFor(() => isBootComplete(), { label: 'backend boot before version fixture cleanup' })
  await isolated.cleanup()
})

const { app } = await import('../app.js')
const packageVersion = JSON.parse(
  await fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
).version

test('public health and server-info endpoints report the package app version', async () => {
  const health = await request(app).get('/api/health').expect(200)
  const serverInfo = await request(app).get('/api/server-info').expect(200)

  assert.equal(health.body.version, packageVersion)
  assert.equal(serverInfo.body.version, packageVersion)
})
