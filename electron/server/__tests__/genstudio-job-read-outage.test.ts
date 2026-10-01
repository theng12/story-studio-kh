/**
 * Reading an accepted job rides out a Gateway restart.
 *
 * Installing a Gateway build restarts it on this Mac and it is unreachable for several seconds. A
 * job read used to give up after four attempts (~3.5 s of backoff), so an image or voice job already
 * accepted and running failed its poll, got one automatic reconnect that hit the same gap, and showed
 * as a failed item although the Gateway finished it moments later.
 *
 * Time is mocked: the backoff is real code, but a test must not sleep ~10 s to see it.
 */
import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
after(() => temp.cleanup())
const { recoverImageWithGenStudio, GENSTUDIO_JOB_READ_ATTEMPTS } = await import('../lib/genstudio-client.js')

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

async function runWithClock<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  const guarded = promise.finally(() => { settled = true })
  guarded.catch(() => {})
  for (let i = 0; i < 4_000 && !settled; i++) {
    mock.timers.tick(250)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return guarded
}

test('a job read that fails for ~10 s of Gateway restart still reaches the finished image', async () => {
  const originalFetch = globalThis.fetch
  let reads = 0
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  try {
    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.endsWith('/v1/images/image_restart')) {
        reads++
        if (reads <= 6) throw new TypeError('fetch failed') // connection refused while the Gateway restarts
        return Response.json({
          id: 'image_restart', state: 'succeeded', model_id: 'm', prompt: 'p', width: 1, height: 1,
          aspect_ratio: '1:1', steps: 1, image_url: '/v1/images/image_restart/file',
        })
      }
      if (url.endsWith('/v1/images/image_restart/file')) return new Response(ONE_PIXEL_PNG)
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof globalThis.fetch
    const result = await runWithClock(recoverImageWithGenStudio('scoped-key', 'image_restart'))
    assert.equal(result.jobId, 'image_restart')
    assert.equal(reads, 7, 'six refused reads, then the answer')
    assert.ok(GENSTUDIO_JOB_READ_ATTEMPTS > 6, 'the budget must cover the outage simulated here')
  } finally {
    globalThis.fetch = originalFetch
    mock.timers.reset()
  }
})

test('a Gateway that never comes back still fails, after the whole read budget', async () => {
  const originalFetch = globalThis.fetch
  let reads = 0
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  try {
    globalThis.fetch = (async () => { reads++; throw new TypeError('fetch failed') }) as typeof globalThis.fetch
    await assert.rejects(runWithClock(recoverImageWithGenStudio('scoped-key', 'image_gone')), /fetch failed/)
    assert.equal(reads, GENSTUDIO_JOB_READ_ATTEMPTS)
  } finally {
    globalThis.fetch = originalFetch
    mock.timers.reset()
  }
})
