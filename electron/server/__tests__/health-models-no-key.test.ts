/**
 * "I have no key" must not look like "there are no models" — v1.4.202
 *
 * `GET /models` answered a missing GenStudio API key with `res.json([])`, an
 * empty catalogue at HTTP 200. Every picker then renders its own confident
 * "no models" empty state, and the customer has no way to tell that the real
 * problem is a key that was never added. AGENTS.md §6.
 *
 * The same file already knew better: `/account` answers the identical condition
 * with a 400 and "Add a GenStudio API key in Settings → This Mac." This pins that
 * `/models` now does the same.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'

import { router as healthRouter } from '../routes/health.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
})
after(async () => { await cleanup() })

describe('GET /models with no Gateway key', () => {
  test('answers with an actionable error rather than an empty catalogue', async () => {
    const app = express()
    app.use(healthRouter)

    const res = await request(app).get('/models')

    assert.notEqual(
      res.status, 200,
      'an empty catalogue and a missing key must not be the same answer',
    )
    assert.equal(res.status, 400)
    assert.match(String(res.body?.detail ?? ''), /API key/i, 'the message must name the thing to fix')
  })
})
