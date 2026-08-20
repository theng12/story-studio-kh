/**
 * Guards the fix from v1.4.14: supertest must bind the IPv4 loopback address
 * it then connects to.
 *
 * Left to itself, supertest calls `app.listen(0)` with no host — an IPv6
 * wildcard bind — and connects to `http://127.0.0.1:<port>`. That wildcard
 * bind coexists happily with another local process holding the same port on
 * 127.0.0.1 specifically, and the specific listener wins, so roughly one
 * request in a few hundred was answered by whatever daemon happened to own
 * that port (Tailscale's LocalAPI, on the machine where this was found —
 * `401 auth required` to every path). Binding 127.0.0.1 explicitly makes the
 * kernel refuse a conflicting port outright, so it can never be handed out.
 *
 * scripts/testing/loopback-supertest.mjs applies the patch; this test is the
 * alarm that goes off if the preload stops being loaded or supertest changes
 * shape underneath it.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: any

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
})

after(async () => { await cleanup() })

test('supertest binds its throwaway server to 127.0.0.1, not the IPv6 wildcard', async () => {
  const pending = request(app).get('/api/health')

  // `listen(port, host)` resolves the host before binding, so the address
  // lands one tick later than a wildcard bind would.
  await new Promise(resolve => setImmediate(resolve))
  const address = (pending as any)._server?.address()

  assert.ok(address, 'supertest should have bound a server for this request')
  assert.equal(address.address, '127.0.0.1',
    'a wildcard bind lets another process on this port shadow the app under test')
  assert.equal(address.family, 'IPv4')
  assert.equal((pending as any).url, undefined,
    'the URL must stay unresolved until end(), when the port is actually known')

  const res = await pending
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'ok')
})
