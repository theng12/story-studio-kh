/**
 * The workspace read is where a chapter-title preview learns where the channel's
 * font-pool rotation stands. A preview that starts the pool from its first face
 * would show a different heading than the render binds.
 *
 * Pinned here: the standing record is returned for the asked script, an
 * unassigned channel answers null (never an invented face), and a read that did
 * not ask for a cursor does not gain one.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

describe('still posts — the standing font-pool cursor is readable', () => {
  test('the workspace returns the cursor for the requested script, and null when unassigned', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const project = await pm.createProject({ name: 'Pool cursor read' })
      const slug = project.slug
      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)

      // No rotation yet: null is the honest answer, not the pool's first face.
      const empty = await request(app).get(`/api/projects/${slug}/still-posts?script=latn`)
      assert.equal(empty.status, 200)
      assert.equal(empty.body.font_pool_cursor, null)

      // A rotation written by the pool writer, read back unchanged.
      await fs.mkdir(store.stillPostsDir(slug), { recursive: true })
      await fs.writeFile(store.fontPoolCursorPath(slug), JSON.stringify({
        cursors: { latn: { last_font_id: 'anton', last_index: 1 } },
      }))
      const standing = await request(app).get(`/api/projects/${slug}/still-posts?script=latn`)
      assert.equal(standing.status, 200)
      assert.deepEqual(standing.body.font_pool_cursor, { last_font_id: 'anton', last_index: 1 })

      // A script the channel has not used is null, and the other script is not leaked.
      const khmr = await request(app).get(`/api/projects/${slug}/still-posts?script=khmr`)
      assert.equal(khmr.body.font_pool_cursor, null)

      // No script asked for = no cursor field; nothing is inferred.
      const plain = await request(app).get(`/api/projects/${slug}/still-posts`)
      assert.equal(plain.status, 200)
      assert.equal('font_pool_cursor' in plain.body, false)
    } finally {
      await isolated.cleanup()
    }
  })
})
