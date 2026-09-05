import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { router } from '../routes/upload.js'

const app = express()
app.use(express.json())
app.use('/api', router)

for (const [method, path] of [
  ['get', '/api/projects/demo/upload/oauth-client?platform=youtube'],
  ['put', '/api/projects/demo/upload/oauth-client'],
  ['delete', '/api/projects/demo/upload/oauth-client?platform=youtube'],
  ['post', '/api/projects/demo/upload/oauth/start'],
  ['get', '/api/projects/demo/upload/oauth/status?flow_id=old-flow'],
] as const) {
  test(`retired project OAuth route ${method.toUpperCase()} ${path} directs to Settings without mutation`, async () => {
    const response = await request(app)[method](path).send({
      platform: 'youtube', client_id: 'must-not-save', client_secret: 'must-not-save',
    })
    assert.equal(response.status, 410)
    assert.match(response.body.detail, /Settings.*YouTube/i)
    assert.equal(JSON.stringify(response.body).includes('must-not-save'), false)
  })
}
