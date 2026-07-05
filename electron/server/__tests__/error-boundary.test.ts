import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { errorBoundary } from '../lib/error-boundary.js'

// The terminal error handler (app.ts mounts this last). These pin its
// contract against a REAL throwing route so a regression can't quietly
// start leaking stack traces or hanging requests.

function appWith(route: express.RequestHandler): express.Express {
  const app = express()
  app.use(express.json())
  app.get('/boom', route)
  app.use(errorBoundary)
  return app
}

describe('errorBoundary', () => {
  test('async route rejection → 500 with generic detail (no internals leaked)', async () => {
    // Express 5 auto-forwards rejected promises from async handlers.
    const app = appWith(async () => { throw new Error('secret db connection string leaked here') })
    const res = await request(app).get('/boom')
    assert.equal(res.status, 500)
    assert.equal(res.body.detail, 'Internal server error')
    assert.ok(!JSON.stringify(res.body).includes('secret db connection'), 'internal message not exposed')
  })

  test('synchronous throw is also caught → 500', async () => {
    const app = appWith(() => { throw new Error('sync boom') })
    const res = await request(app).get('/boom')
    assert.equal(res.status, 500)
    assert.equal(res.body.detail, 'Internal server error')
  })

  test('err.status is honoured', async () => {
    const app = appWith(async () => {
      const e: any = new Error('bad input')
      e.status = 400
      throw e
    })
    const res = await request(app).get('/boom')
    assert.equal(res.status, 400)
  })

  test('err.statusCode is honoured (alternate field)', async () => {
    const app = appWith(async () => {
      const e: any = new Error('conflict')
      e.statusCode = 409
      throw e
    })
    const res = await request(app).get('/boom')
    assert.equal(res.status, 409)
  })

  test('err.expose=true → the real message reaches the client', async () => {
    const app = appWith(async () => {
      const e: any = new Error('Quota exceeded for this provider')
      e.status = 429
      e.expose = true
      throw e
    })
    const res = await request(app).get('/boom')
    assert.equal(res.status, 429)
    assert.equal(res.body.detail, 'Quota exceeded for this provider')
  })

  test('does not double-respond once headers are sent', async () => {
    // Handler streams a partial response, THEN throws. The boundary must
    // not try to set a status on an already-sent response (which would
    // throw ERR_HTTP_HEADERS_SENT and crash the process). It delegates to
    // Express's finalhandler, which destroys the socket — so the client
    // sees an aborted request (detectable truncation) rather than a
    // connection that hangs forever waiting for the body to end.
    const app = appWith((_req, res) => {
      res.status(200).write('partial')
      throw new Error('late failure')
    })
    await assert.rejects(request(app).get('/boom'))
  })
})
