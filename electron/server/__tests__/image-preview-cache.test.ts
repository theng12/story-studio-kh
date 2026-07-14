import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'preview-cache'

describe('Image preview cache policy', () => {
  before(async () => {
    tmp = await useTempDataDir()
    const projectDir = path.join(tmp.dir, 'projects', SLUG)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: SLUG,
      name: 'Preview Cache',
      output_root: './episodes',
    }))
  })

  after(async () => {
    await tmp.cleanup()
  })

  test('revalidates generated images that may be replaced at the same path', async () => {
    const imagePath = path.join(tmp.dir, 'projects', SLUG, 'preview.png')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    await fs.writeFile(imagePath, png)

    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    const { app } = await import('../app.js')
    const response = await request(app)
      .get(`/api/projects/${SLUG}/video-editor/preview-image`)
      .query({ path: imagePath })

    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^image\/png/)
    assert.equal(response.headers['cache-control'], 'private, no-cache, must-revalidate')
    assert.deepEqual(response.body, png)
  })
})
