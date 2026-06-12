import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { TtlCache, swrFetch } from '../lib/ttl-cache.js'

// v1.0.338 — stale-while-revalidate cache behind the provider-list endpoints
// (/voicestudio/voices, /voicestudio/models, /macos/voices). The contract that
// fixes "missing providers": a failed probe with ANY cached value (even
// expired) serves the cached value flagged stale instead of erroring.

describe('TtlCache', () => {
  test('fresh get returns the value, expired get returns undefined', async () => {
    const c = new TtlCache<string>(50)
    c.set('k', 'v')
    assert.equal(c.get('k'), 'v')
    await new Promise(r => setTimeout(r, 70))
    assert.equal(c.get('k'), undefined, 'expired entries are not fresh')
    assert.equal(c.getStale('k'), 'v', 'but stay readable via getStale')
  })

  test('evicts oldest entries past maxEntries', () => {
    const c = new TtlCache<number>(60_000, 3)
    c.set('a', 1); c.set('b', 2); c.set('c', 3); c.set('d', 4)
    assert.equal(c.getStale('a'), undefined, 'oldest evicted')
    assert.equal(c.getStale('d'), 4)
  })
})

describe('swrFetch', () => {
  test('miss → loader runs, result cached; hit → loader NOT called again', async () => {
    const c = new TtlCache<string>(60_000)
    let calls = 0
    const loader = async () => { calls++; return `result-${calls}` }

    const r1 = await swrFetch(c, 'key', loader)
    assert.equal(r1.value, 'result-1')
    assert.equal(r1.fromCache, false)
    assert.equal(r1.stale, false)

    const r2 = await swrFetch(c, 'key', loader)
    assert.equal(r2.value, 'result-1', 'served from cache')
    assert.equal(r2.fromCache, true)
    assert.equal(calls, 1, 'loader ran once')
  })

  test('forceRefresh bypasses a fresh cache entry', async () => {
    const c = new TtlCache<string>(60_000)
    let calls = 0
    const loader = async () => { calls++; return `result-${calls}` }
    await swrFetch(c, 'key', loader)
    const r = await swrFetch(c, 'key', loader, { forceRefresh: true })
    assert.equal(r.value, 'result-2')
    assert.equal(calls, 2)
  })

  test('loader failure + expired entry → serves stale instead of throwing', async () => {
    const c = new TtlCache<string>(10)
    await swrFetch(c, 'key', async () => 'good-old-value')
    await new Promise(r => setTimeout(r, 30)) // let it expire

    const r = await swrFetch(c, 'key', async () => { throw new Error('endpoint down') })
    assert.equal(r.value, 'good-old-value', 'last-known-good served')
    assert.equal(r.stale, true, 'flagged stale so the UI can hint')
  })

  test('loader failure with NO cached value → rethrows', async () => {
    const c = new TtlCache<string>(60_000)
    await assert.rejects(
      () => swrFetch(c, 'never-cached', async () => { throw new Error('probe failed') }),
      /probe failed/,
    )
  })

  test('concurrent calls for the same key share ONE loader run', async () => {
    const c = new TtlCache<string>(60_000)
    let calls = 0
    const loader = async () => {
      calls++
      await new Promise(r => setTimeout(r, 30))
      return 'shared'
    }
    const [a, b, d] = await Promise.all([
      swrFetch(c, 'key', loader),
      swrFetch(c, 'key', loader),
      swrFetch(c, 'key', loader),
    ])
    assert.equal(a.value, 'shared')
    assert.equal(b.value, 'shared')
    assert.equal(d.value, 'shared')
    assert.equal(calls, 1, 'in-flight dedupe collapsed 3 calls into 1')
  })

  test('different keys do not collide', async () => {
    const c = new TtlCache<string>(60_000)
    const r1 = await swrFetch(c, 'k1', async () => 'v1')
    const r2 = await swrFetch(c, 'k2', async () => 'v2')
    assert.equal(r1.value, 'v1')
    assert.equal(r2.value, 'v2')
  })
})
