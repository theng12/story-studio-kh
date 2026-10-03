/**
 * `_helpers` alone must make supertest bind 127.0.0.1 — without the backend runner's
 * NODE_OPTIONS preload. The Gateway's Story content-delivery round trip imports only
 * `_helpers`, and without the loopback bind a local daemon holding the same port on
 * 127.0.0.1 answered a Series Formula install with `HTTP 404 {"detail":"Not Found"}`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPERS = pathToFileURL(path.join(HERE, '_helpers.ts')).href

test('importing _helpers binds supertest to 127.0.0.1 even without the runner preload', () => {
  const script = `
    await import(${JSON.stringify(HELPERS)})
    const { default: express } = await import('express')
    const { default: request } = await import('supertest')
    const app = express()
    app.post('/api/content-store/releases/:id/install', (req, res) => { res.json({ local: req.socket.localAddress }) })
    const res = await request(app).post('/api/content-store/releases/formula/install').send({})
    process.stdout.write(JSON.stringify({ status: res.status, local: res.body.local }))
  `
  const env = { ...process.env }
  delete env.NODE_OPTIONS // the runner's preload would hide a missing import in _helpers
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.join(HERE, '..', '..', '..'), env, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(child.status, 0, child.stderr)
  // A wildcard ([::]) bind would report the IPv4-mapped '::ffff:127.0.0.1'.
  assert.deepEqual(JSON.parse(child.stdout), { status: 200, local: '127.0.0.1' })
})
