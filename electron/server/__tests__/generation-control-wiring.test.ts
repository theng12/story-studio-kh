/**
 * Durable generation-control boundaries.
 *
 * These checks deliberately combine the real GenStudio video seam (to prove
 * callback timing) with focused source contracts for queue executors. The
 * source contracts guard wiring which is otherwise difficult to reach without
 * constructing full project media trees.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
  'base64',
)

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('GenStudio video reports each accepted variant before its first status poll', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  const accepted: Array<{ taskId: string; key: string; variantIndex: number; polledBeforeCallback: boolean }> = []
  const imagePath = path.join(temp.dir, 'source.png')
  await fs.writeFile(imagePath, ONE_PIXEL_PNG)

  try {
    const settings = await import('../services/app-settings.js')
    await settings.setGenStudioUrl(service.baseUrl)
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.origin !== service.baseUrl || !['/v1/video/models', '/v1/videos/models'].includes(url.pathname)) return response
      const models = await response.json() as Array<Record<string, unknown>>
      return new Response(JSON.stringify(models.map(model => ({ ...model, available: true }))), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    await import('../providers/video/genstudio.js')
    const { registry } = await import('../providers/registry.js')
    const provider = registry.getVideoProvider('genstudio-video')
    assert.ok(provider)

    service.reset()
    service.queueScenario('video', { states: ['accepted', 'running', 'succeeded'] })
    service.queueScenario('video', { states: ['accepted', 'running', 'succeeded'] })
    await provider.generateVideo({
      mode: 'frames',
      prompt: 'A slow camera move over an ancient stone observatory.',
      apiKey: MOCK_GENSTUDIO_FULL_KEY,
      aspectRatio: 'landscape',
      numberOfVideos: 2,
      modelId: 'mock-video-v1',
      startImagePath: imagePath,
      providerParams: { duration_seconds: 5, resolution: '720p' },
      idempotencyIdentity: 'generation-control-wiring',
      onJobAccepted: (taskId, key, variantIndex) => {
        accepted.push({
          taskId,
          key,
          variantIndex,
          polledBeforeCallback: service.requests.some(request => (
            request.method === 'GET' && request.path === `/v1/videos/${taskId}`
          )),
        })
      },
    })

    assert.deepEqual(accepted.map(item => item.variantIndex), [0, 1])
    assert.ok(accepted.every(item => item.taskId && item.key.startsWith('story-video-')))
    assert.ok(accepted.every(item => !item.polledBeforeCallback), 'accepted IDs must persist before polling')
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('queue producers persist accepted work and honour the shared local-stop probe', () => {
  const sceneImage = source('../generators/scene-image.ts')
  const composition = source('../generators/composition-template.ts')
  const aiVideo = source('../generators/ai-video.ts')
  const genstudioVideo = source('../providers/video/genstudio.ts')

  assert.match(sceneImage, /isCancelled:\s*\(\)\s*=>\s*jq\.isCancelled\(job\.job_id\)/)
  assert.match(sceneImage, /onJobAccepted:\s*async\s*\(taskId,\s*\w+IdempotencyKey\)/)
  assert.match(sceneImage, /recordTaskStrict\(outDir,\s*`\$\{scene_id\}\.png`/)
  assert.match(sceneImage, /operation:\s*'image'/)
  assert.match(sceneImage, /last_state:\s*'accepted'/)

  assert.match(composition, /isCancelled:\s*\(\)\s*=>\s*jq\.isCancelled\(job\.job_id\)/)
  assert.match(composition, /const idempotencyKey\s*=\s*buildGenStudioImageIdempotencyKey/)
  assert.match(composition, /recordTaskStrict\(outDir,\s*COMPOSITION_FILENAME/)
  assert.match(composition, /last_state:\s*'prepared'/)
  assert.match(composition, /last_state:\s*'accepted'/)

  assert.match(aiVideo, /onJobAccepted:\s*async\s*\(taskId,\s*idempotencyKey,\s*variantIndex\)/)
  assert.match(aiVideo, /recordTaskStrict\(videoDir,\s*filename/)
  assert.match(aiVideo, /operation:\s*'video'/)
  assert.match(aiVideo, /last_state:\s*'accepted'/)
  assert.match(genstudioVideo, /onJobAccepted\?\.\(taskId,\s*idempotencyKey,\s*index\)/)
})

test('every existing GenStudio producer keeps a prepared-to-accepted durable boundary', () => {
  for (const relativePath of [
    '../generators/audio.ts',
    '../generators/subtitles.ts',
    '../generators/images.ts',
    '../generators/scene-images-batch.ts',
    '../generators/continuity-render.ts',
    '../generators/image-pool-generate.ts',
    '../generators/scene-clip.ts',
  ]) {
    const contents = source(relativePath)
    assert.match(contents, /['"]prepared['"]/, `${relativePath} writes prepared evidence`)
    assert.match(contents, /onJobAccepted/, `${relativePath} writes accepted evidence before provider polling`)
  }
})
