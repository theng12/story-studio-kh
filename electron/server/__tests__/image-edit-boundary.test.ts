import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import express from 'express'
import request from 'supertest'
import { editImage, IMAGE_EDIT_MODELS } from '../lib/image-edit-client.js'
import { IMAGE_EDIT_UNAVAILABLE_DETAIL, router } from '../routes/image-edit.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, '../../..')

describe('GenStudio-only image-edit boundary', () => {
  it('returns an explicit unavailable response without invoking a provider', async () => {
    const app = express()
    app.use(express.json())
    app.use(router)

    const originalFetch = globalThis.fetch
    let providerCalls = 0
    globalThis.fetch = (async () => {
      providerCalls += 1
      throw new Error('Direct provider invocation is forbidden')
    }) as typeof fetch

    try {
      const caps = await request(app).get('/projects/example/image-edit/caps')
      assert.equal(caps.status, 503)
      assert.deepEqual(caps.body.models, [])
      assert.equal(caps.body.default, null)
      assert.equal(caps.body.detail, IMAGE_EDIT_UNAVAILABLE_DETAIL)

      const edit = await request(app)
        .post('/projects/example/edit-image')
        .send({
          image_path: '/tmp/reference.png',
          prompt: 'remove the watermark',
          model: 'legacy-direct-provider',
        })
      assert.equal(edit.status, 503)
      assert.equal(edit.body.detail, IMAGE_EDIT_UNAVAILABLE_DETAIL)
      assert.equal(providerCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps the retired client inert and publishes no edit models', async () => {
    assert.deepEqual(IMAGE_EDIT_MODELS, [])
    await assert.rejects(
      editImage({
        imagePath: '/tmp/reference.png',
        prompt: 'remove the watermark',
        model: 'legacy-direct-provider',
      }),
      /qualified Gateway image-edit endpoint/,
    )
  })

  it('contains no direct provider transport and hides edit actions', async () => {
    const serverSources = await Promise.all([
      'electron/server/routes/image-edit.ts',
      'electron/server/lib/image-edit-client.ts',
    ].map(relative => fs.readFile(path.join(REPO_ROOT, relative), 'utf8')))

    const forbiddenTransport = /generativelanguage\.googleapis\.com|api\.openai\.com|queue\.fal\.run|submitGeneration\s*\(/
    for (const source of serverSources) {
      assert.doesNotMatch(source, forbiddenTransport)
    }

    const customerActionSources = await Promise.all([
      'frontend/components/ImagePreviewLightbox.vue',
      'frontend/pages/projects/[slug]/images.vue',
      'frontend/pages/projects/[slug]/image-prompts.vue',
      'frontend/pages/projects/[slug]/video-assembly.vue',
    ].map(relative => fs.readFile(path.join(REPO_ROOT, relative), 'utf8')))

    for (const source of customerActionSources) {
      assert.doesNotMatch(source, /<ImageEditDialog\b|Edit with AI|\/edit-image/)
    }
  })
})
