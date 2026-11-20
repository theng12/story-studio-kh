import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'

// The app disables V8 snapshots deliberately — they hold prompts and project text. The route exists
// so a memory investigation can be answered with an artefact instead of a guess, but only when an
// operator names a directory they are willing to have such a file in.
test('heap snapshots are off until the operator names a directory', async () => {
  delete process.env.SS_HEAP_SNAPSHOT_DIR
  const { router } = await import('../routes/diagnostics.js')
  const app = express()
  app.use('/api', router)
  const off = await request(app).post('/api/diagnostics/heap-snapshot')
  assert.equal(off.status, 404)
  assert.match(off.body.detail, /SS_HEAP_SNAPSHOT_DIR/)
})
