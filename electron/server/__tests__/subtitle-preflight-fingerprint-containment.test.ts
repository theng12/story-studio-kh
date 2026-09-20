import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { after, before, describe, test } from 'node:test'

import { requireAllowedHost } from '../lib/security.js'
import { useTempDataDir } from './_helpers.js'

const SLUG = 'subtitle-fingerprint-containment'

let temp: { dir: string; cleanup: () => Promise<void> }
let projectRoot = ''
let mediaRoot = ''
let outsideRoot = ''
let app: express.Express

before(async () => {
  temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const { router } = await import('../routes/video.js')
  const project = await pm.createProject({ name: 'Subtitle Fingerprint Containment' })
  projectRoot = (await pm.getProjectOutputRoot(project.slug))!
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssk-media-root-'))
  outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssk-outside-root-'))
  await pm.updateProject(project.slug, { media_root: mediaRoot } as any)

  // This models the real server-mode boundary: a non-loopback Host is admitted
  // by the server-mode host policy, then the route must still contain the path.
  app = express().use(requireAllowedHost(true)).use('/api', router)
})

after(async () => {
  await temp?.cleanup()
  await Promise.all([
    mediaRoot && fs.rm(mediaRoot, { recursive: true, force: true }),
    outsideRoot && fs.rm(outsideRoot, { recursive: true, force: true }),
  ])
})

function endpoint(filePath: string): string {
  return `/api/projects/${SLUG}/video-editor/subtitle-preflight/EP0001/fingerprint`
    + `?path=${encodeURIComponent(filePath)}`
}

describe('subtitle fingerprint path admission', () => {
  test('fingerprints files in the Library', async () => {
    const filePath = path.join(projectRoot, 'EP0001_stitched.srt')
    await fs.writeFile(filePath, 'subtitle')

    const response = await request(app).get(endpoint(filePath)).set('Host', 'story-studio.example')

    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(response.body.fingerprint, { mtime_ms: response.body.fingerprint.mtime_ms, size: 8 })
  })

  test('fingerprints files in a configured media root', async () => {
    const filePath = path.join(mediaRoot, 'EP0001_external.srt')
    await fs.writeFile(filePath, 'external subtitle')

    const response = await request(app).get(endpoint(filePath)).set('Host', 'story-studio.example')

    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.fingerprint.size, 17)
  })

  test('refuses an outside file without statting it for a fingerprint', async () => {
    const filePath = path.join(outsideRoot, 'private.srt')
    await fs.writeFile(filePath, 'private subtitle')

    const response = await request(app).get(endpoint(filePath)).set('Host', 'story-studio.example')

    assert.equal(response.status, 403, JSON.stringify(response.body))
    assert.equal(response.body.fingerprint, undefined)
  })

  test('refuses a missing file below an in-Library dangling symlink to outside', async () => {
    const link = path.join(projectRoot, 'EP0001_dangling')
    await fs.symlink(path.join(outsideRoot, 'not-mounted'), link)

    const response = await request(app)
      .get(endpoint(path.join(link, 'private.srt')))
      .set('Host', 'story-studio.example')

    assert.equal(response.status, 403, JSON.stringify(response.body))
    assert.equal(response.body.fingerprint, undefined)
  })

  test('reports a removed admitted file as missing', async () => {
    const filePath = path.join(projectRoot, 'EP0001_removed.srt')
    await fs.writeFile(filePath, 'gone')
    await fs.rm(filePath)

    const response = await request(app).get(endpoint(filePath)).set('Host', 'story-studio.example')

    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(response.body, { fingerprint: null, missing: true })
  })
})
