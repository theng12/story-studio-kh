import { after, afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'fs/promises'

import { router as healthRouter } from '../routes/health.js'
import { proactiveRecoverySweep } from '../services/boot-recovery.js'
import { useTempDataDir } from './_helpers.js'
/**
 * Claim an isolated data dir before anything runs.
 *
 * These are pure-logic tests, but the loaders they exercise (niche,
 * topic-pack, format) look for user overrides under
 * `${projectsRoot()}/.niches` and friends. With no data dir claimed that
 * resolves to the machine owner's REAL projects folder, so results would
 * depend on what they happen to have installed there. Reads only today —
 * the owner's folder has no override directories — but it is the same
 * isolation leak the projects-root refactor exists to close.
 */
const isolatedDataDir = await useTempDataDir()
after(() => isolatedDataDir.cleanup())

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

describe('GenStudio-only legacy network boundary', () => {
  test('registers only one public handler for each formerly duplicated health route', () => {
    const paths = (healthRouter as any).stack
      .map((layer: any) => layer.route?.path)
      .filter(Boolean)

    assert.equal(paths.filter((path: string) => path === '/models').length, 1, '/models')
    // The caller-less legacy duplicates are gone, not merely deduplicated.
    for (const routePath of ['/usage', '/usage/rollup', '/projects/:slug/health', '/connectivity/precheck', '/test-key/:provider', '/projects/:slug/test-key/:provider']) {
      assert.equal(paths.includes(routePath), false, routePath)
    }
  })

  test('boot recovery is evidence-only and provider clients are absent from recovery services', async () => {
    const calls = trapExternalFetch()
    const summary = await proactiveRecoverySweep({ maxItems: 0, onLog: () => undefined })
    assert.equal(summary.recovered, 0)
    assert.deepEqual(calls, [])

    const bootSource = await readFile(new URL('../services/boot-recovery.ts', import.meta.url), 'utf8')
    assert.equal(bootSource.includes('api.kie.ai'), false)
    assert.equal(bootSource.includes('queue.fal.run'), false)
    assert.equal(bootSource.includes('studiohub-client'), false)
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
    assert.equal(videoRoute.includes('studiohub-client'), false)
  })
})
