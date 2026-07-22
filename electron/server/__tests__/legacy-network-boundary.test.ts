import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { readFile } from 'fs/promises'

import { router as healthRouter } from '../routes/health.js'
import { router as jobsRouter } from '../routes/jobs.js'
import { proactiveRecoverySweep } from '../services/boot-recovery.js'
import { fetchFalVideo, fetchKieVideo } from '../services/video-reconciler.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function trapExternalFetch(): string[] {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    throw new Error(`Unexpected external request: ${String(input)}`)
  }) as typeof fetch
  return calls
}

function mounted(router: express.Router) {
  const app = express()
  app.use(express.json())
  app.use(router)
  return app
}

describe('GenStudio-only legacy network boundary', () => {
  test('registers only one public handler for each formerly duplicated health route', () => {
    const paths = (healthRouter as any).stack
      .map((layer: any) => layer.route?.path)
      .filter(Boolean)

    for (const routePath of [
      '/models',
      '/usage',
      '/usage/pricing',
      '/usage/rollup',
      '/projects/:slug/health',
      '/connectivity/precheck',
      '/test-key/:provider',
      '/projects/:slug/test-key/:provider',
      '/local-servers/status',
    ]) {
      assert.equal(paths.filter((path: string) => path === routePath).length, 1, routePath)
    }
  })

  test('rejects legacy key checks and local-server discovery without network access', async () => {
    const calls = trapExternalFetch()
    const app = mounted(healthRouter)

    const key = await request(app).post('/test-key/kie').send({ apiKey: 'legacy-key' })
    assert.equal(key.status, 410)
    assert.equal(key.body.code, 'GENSTUDIO_ONLY')

    const local = await request(app).get('/local-servers/status')
    assert.equal(local.status, 410)
    assert.equal(local.body.code, 'GENSTUDIO_ONLY')
    assert.deepEqual(calls, [])
  })

  test('retires the Studio Hub repair endpoint without enqueueing or contacting Hub', async () => {
    const calls = trapExternalFetch()
    const response = await request(mounted(jobsRouter))
      .post('/projects/example/jobs/legacy-job/repair-hub-image')

    assert.equal(response.status, 410)
    assert.equal(response.body.code, 'GENSTUDIO_ONLY')
    assert.match(response.body.detail, /no Hub or provider request was attempted/i)
    assert.deepEqual(calls, [])
  })

  test('legacy video fetch compatibility exports are inert', async () => {
    const calls = trapExternalFetch()
    const kie = await fetchKieVideo('task-1', '/jobs/recordInfo', 'secret')
    const fal = await fetchFalVideo('https://queue.fal.run/task-1')

    assert.equal(kie.status, 'unknown')
    assert.equal(fal.status, 'unknown')
    assert.match(kie.message || '', /direct legacy provider recovery is retired/i)
    assert.match(fal.message || '', /direct legacy provider recovery is retired/i)
    assert.deepEqual(calls, [])
  })

  test('boot recovery is evidence-only and provider clients are absent from recovery services', async () => {
    const calls = trapExternalFetch()
    const summary = await proactiveRecoverySweep({ maxItems: 0, onLog: () => undefined })
    assert.equal(summary.recovered, 0)
    assert.deepEqual(calls, [])

    const bootSource = await readFile(new URL('../services/boot-recovery.ts', import.meta.url), 'utf8')
    const videoSource = await readFile(new URL('../services/video-reconciler.ts', import.meta.url), 'utf8')
    for (const source of [bootSource, videoSource]) {
      assert.equal(source.includes('api.kie.ai'), false)
      assert.equal(source.includes('queue.fal.run'), false)
      assert.equal(source.includes('studiohub-client'), false)
    }
    assert.equal(bootSource.includes("../lib/kie-client.js"), false)
    assert.equal(bootSource.includes("../lib/genaipro-client.js"), false)
    assert.equal(bootSource.includes("../lib/fal-client.js"), false)
  })

  test('does not mount Chat Studio or send final assembly to Studio Hub', async () => {
    const routeIndex = await readFile(new URL('../routes/index.ts', import.meta.url), 'utf8')
    const videoGenerator = await readFile(new URL('../generators/video.ts', import.meta.url), 'utf8')
    const videoRoute = await readFile(new URL('../routes/video.ts', import.meta.url), 'utf8')

    assert.equal(routeIndex.includes('chatstudioRouter'), false)
    assert.equal(videoGenerator.includes('tryRunRemoteVideoAssembly'), false)
    assert.equal(videoGenerator.includes('studiohub-client'), false)
    assert.match(videoRoute, /render_target\s*=\s*'local'/)
    assert.match(videoRoute, /remote_render_requested\s*=\s*false/)
  })
})
