import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { nextTick, watch } from 'vue'

// Mock $fetch before importing composables
let fetchCalls: Array<{ url: string; options: any }> = []
let fetchDelay = 0
let fetchResponses: Map<string, any> = new Map()

;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
 fetchCalls.push({ url, options })
 if (fetchDelay > 0) {
 await new Promise(resolve => setTimeout(resolve, fetchDelay))
 }
 const response = fetchResponses.get(url)
 if (response instanceof Error) throw response
 return response ?? { ok: true }
}

describe('SWR cache', () => {
 beforeEach(async () => {
 fetchCalls = []
 fetchDelay = 0
 fetchResponses.clear()
 const { _clearApiGetCacheForTests } = await import('../composables/useApi')
 _clearApiGetCacheForTests()
 const { _swrClearForTests } = await import('../utils/swrCache')
 _swrClearForTests()
 })

 test('returns cached value instantly on second read, refreshes in background', async () => {
 const { useApi } = await import('../composables/useApi')
 const { swrSubscribe } = await import('../utils/swrCache')
 fetchResponses.set('/api/test/data', { version: 1 })
 fetchDelay = 50

 const { get } = useApi()

 // First read: must await
 const start1 = Date.now()
 const result1 = await get('/test/data')
 const elapsed1 = Date.now() - start1
 assert.equal(result1.version, 1)
 assert.ok(elapsed1 >= 40, 'First read should wait for fetch')

 // Update the response for the background refresh
 fetchResponses.set('/api/test/data', { version: 2 })

 // Subscribe to wait for background refresh to land fresh value
 const refreshDone = new Promise<void>(resolve => {
  const unsub = swrSubscribe('GET:/test/data', entry => {
   if (!entry.refreshing && entry.value?.version === 2) {
    unsub()
    resolve()
   }
  })
 })

 // Second read: should return cached value instantly
 const start2 = Date.now()
 const result2 = await get('/test/data')
 const elapsed2 = Date.now() - start2
 assert.equal(result2.version, 1, 'Should return stale cached value')
 assert.ok(elapsed2 < 20, 'Second read should be instant (< 20ms)')

 // Wait for background refresh to complete
 await refreshDone

 // Third read should now have the fresh value
 const result3 = await get('/test/data')
 assert.equal(result3.version, 2, 'Should have fresh value after background refresh')
 })

 test('shares in-flight requests', async () => {
 const { useApi } = await import('../composables/useApi')
 fetchResponses.set('/api/test/shared', { id: 'test' })
 fetchDelay = 100

 const { get } = useApi()

 // Fire three concurrent reads
 const [r1, r2, r3] = await Promise.all([
 get('/test/shared'),
 get('/test/shared'),
 get('/test/shared'),
 ])

 // All should get the same value
 assert.deepEqual(r1, { id: 'test' })
 assert.deepEqual(r2, { id: 'test' })
 assert.deepEqual(r3, { id: 'test' })

 // Should only have made one fetch call
 const testCalls = fetchCalls.filter(c => c.url.endsWith('/test/shared'))
 assert.equal(testCalls.length, 1, 'Should share in-flight request')
 })

 test('invalidates on mutation — next read fetches fresh', async () => {
 const { useApi } = await import('../composables/useApi')
 fetchResponses.set('/api/projects/alpha/data', { revision: 1 })

 const { get, post } = useApi()

 // Populate cache
 await get('/projects/alpha/data')
 const fetchesBeforeMutate = fetchCalls.filter(c => c.url.endsWith('/projects/alpha/data')).length
 assert.equal(fetchesBeforeMutate, 1)

 // Mutate the same path the page re-reads (the "save, then the page
 // reloads what it saved" shape).
 fetchResponses.set('/api/projects/alpha/data', { revision: 2 })
 await post('/projects/alpha/data', { value: 'new' })

 // Next read should fetch fresh (not use stale cache)
 const result = await get('/projects/alpha/data')
 assert.equal(result.revision, 2, 'Should fetch fresh after invalidation')
 const fetchesAfterMutate = fetchCalls.filter(c => c.url.endsWith('/projects/alpha/data') && c.options?.method !== 'POST').length
 assert.equal(fetchesAfterMutate, 2, 'Should have made 2 fetches total')
 })

 test('episode isolation: different episodes have different cache keys', async () => {
 const { useApi } = await import('../composables/useApi')
 fetchResponses.set('/api/projects/alpha/episodes/EP001/scenes', { scenes: ['scene1'] })
 fetchResponses.set('/api/projects/alpha/episodes/EP002/scenes', { scenes: ['scene2'] })

 const { get } = useApi()

 const ep1 = await get('/projects/alpha/episodes/EP001/scenes')
 const ep2 = await get('/projects/alpha/episodes/EP002/scenes')

 assert.deepEqual(ep1.scenes, ['scene1'])
 assert.deepEqual(ep2.scenes, ['scene2'])
 assert.equal(fetchCalls.length, 2, 'Should make separate requests for different episodes')
 })

 test('failed refresh keeps old data and marks error via reactive refs', async () => {
 const { useApi } = await import('../composables/useApi')
 const { _swrPeekForTests, swrSubscribe } = await import('../utils/swrCache')

 fetchResponses.set('/api/test/flaky', { value: 'original' })
 fetchDelay = 30

 const { get } = useApi()

 // First successful fetch
 const result1 = await get('/test/flaky')
 assert.equal(result1.value, 'original')

 // Make the next fetch fail
 fetchResponses.set('/api/test/flaky', new Error('Network error'))

 // Subscribe to wait for background refresh to fail
 const refreshFailed = new Promise<void>(resolve => {
  const unsub = swrSubscribe('GET:/test/flaky', entry => {
   if (!entry.refreshing && entry.error) {
    unsub()
    resolve()
   }
  })
 })

 // Trigger a background refresh (returns stale, refreshes in bg)
 const result2 = await get('/test/flaky')
 assert.equal(result2.value, 'original', 'Should return stale value')

 // Wait for the background refresh to fail
 await refreshFailed

 // Check the cache entry — should have old value and error marked
 const entry = _swrPeekForTests('GET:/test/flaky')
 assert.ok(entry, 'Should have cache entry')
 assert.equal(entry?.value?.value, 'original', 'Should keep old data on failed refresh')
 assert.ok(entry?.error, 'Should have error message')
 assert.equal(entry?.refreshing, false, 'Should not be refreshing after failure')
 })

 test('never caches auth, health, streams, or file downloads', async () => {
 const { useApi } = await import('../composables/useApi')
 fetchResponses.set('/api/auth/me', { user: 'test' })
 fetchResponses.set('/api/health', { status: 'ok' })
 fetchResponses.set('/api/projects/alpha/jobs/stream', { jobs: [] })
 fetchResponses.set('/api/projects/alpha/download/file.mp4', { blob: 'data' })

 const { get } = useApi()

 // Call each twice
 await get('/auth/me')
 await get('/auth/me')
 await get('/health')
 await get('/health')
 await get('/projects/alpha/jobs/stream')
 await get('/projects/alpha/jobs/stream')
 await get('/projects/alpha/download/file.mp4')
 await get('/projects/alpha/download/file.mp4')

 // Each should have been fetched twice (no caching)
 assert.equal(fetchCalls.filter(c => c.url.includes('/auth/me')).length, 2)
 assert.equal(fetchCalls.filter(c => c.url.includes('/health')).length, 2)
 assert.equal(fetchCalls.filter(c => c.url.includes('/stream')).length, 2)
 assert.equal(fetchCalls.filter(c => c.url.includes('/download')).length, 2)
 })

 test('respects cache: no-store option', async () => {
 const { useApi } = await import('../composables/useApi')
 fetchResponses.set('/api/test/explicit', { version: 1 })

 const { get } = useApi()

 await get('/test/explicit')
 await get('/test/explicit', { cache: 'no-store' })
 await get('/test/explicit')

 // Should fetch 3 times (no caching for no-store)
 assert.equal(fetchCalls.filter(c => c.url.endsWith('/test/explicit')).length, 3)
 })

 test('LRU eviction when exceeding bounds', async () => {
 const { useApi } = await import('../composables/useApi')
 const { _swrStatsForTests } = await import('../utils/swrCache')

 // Create more than MAX_ENTRIES (200) cache entries
 for (let i = 0; i < 250; i++) {
 fetchResponses.set(`/api/test/evict/${i}`, { id: i })
 await (await import('../composables/useApi')).useApi().get(`/test/evict/${i}`)
 }

 const stats = _swrStatsForTests()
 assert.ok(stats.entries <= 200, `Should evict to stay under 200 entries, got ${stats.entries}`)
 })

 test('clearAllCaches removes everything — next read fetches fresh', async () => {
 const { useApi, clearAllCaches } = await import('../composables/useApi')
 const { _swrPeekForTests, swrSubscribe } = await import('../utils/swrCache')
 fetchResponses.set('/api/test/clear', { data: 'test' })

 const { get } = useApi()
 await get('/test/clear')

 // Wait for any background refresh to settle
 const entry = _swrPeekForTests('GET:/test/clear')
 if (entry?.refreshing) {
  await new Promise<void>(resolve => {
   const unsub = swrSubscribe('GET:/test/clear', e => {
    if (!e.refreshing) { unsub(); resolve() }
   })
  })
 }
 await nextTick()
 const callsAfterFirst = fetchCalls.filter(c => c.url.endsWith('/test/clear')).length

 // Clear all caches
 clearAllCaches()

 // Should fetch again (cache was cleared)
 const result = await get('/test/clear')
 assert.deepEqual(result, { data: 'test' })
 const callsAfterClear = fetchCalls.filter(c => c.url.endsWith('/test/clear')).length
 assert.ok(callsAfterClear > callsAfterFirst, `Should fetch after clear (before: ${callsAfterFirst}, after: ${callsAfterClear})`)
 })

 test('job events invalidate related cache entries', async () => {
 const { useApi } = await import('../composables/useApi')
 const { swrInvalidate } = await import('../utils/swrCache')

 fetchResponses.set('/api/projects/alpha/episodes', { episodes: [] })
 fetchResponses.set('/api/projects/alpha/jobs', { jobs: [] })

 const { get } = useApi()

 // Populate cache
 await get('/projects/alpha/episodes')
 await get('/projects/alpha/jobs')
 assert.equal(fetchCalls.filter(c => c.url.includes('/projects/alpha')).length, 2)

 // Simulate job event invalidation
 swrInvalidate(/^GET:\/projects\/alpha/)

 // Next reads should fetch fresh (not use invalidated cache)
 await get('/projects/alpha/episodes')
 await get('/projects/alpha/jobs')
 assert.equal(fetchCalls.filter(c => c.url.includes('/projects/alpha')).length, 4)
 })
})

describe('useApiData composable', () => {
 beforeEach(async () => {
 fetchCalls = []
 fetchDelay = 0
 fetchResponses.clear()
 const { _clearApiGetCacheForTests } = await import('../composables/useApi')
 _clearApiGetCacheForTests()
 const { _swrClearForTests } = await import('../utils/swrCache')
 _swrClearForTests()
 })

 test('provides reactive data/refreshing/error/updatedAt', async () => {
 const { useApiData } = await import('../composables/useApiData')
 fetchResponses.set('/api/test/reactive', { value: 'initial' })
 fetchDelay = 50

 const { data, refreshing, error, updatedAt } = useApiData(() => '/test/reactive')

 // Initially null/loading
 assert.equal(data.value, null)
 assert.equal(refreshing.value, true)

 // Wait for fetch
 await new Promise<void>(resolve => {
  if (!refreshing.value && data.value !== null) { resolve(); return }
  const stop = watch([refreshing, data], () => {
   if (!refreshing.value && data.value !== null) {
    stop()
    resolve()
   }
  })
 })
 await nextTick()

 assert.deepEqual(data.value, { value: 'initial' })
 assert.equal(refreshing.value, false)
 assert.equal(error.value, null)
 assert.ok(updatedAt.value, 'Should have updatedAt timestamp')
 })

 test('path change triggers new fetch with fresh data', async () => {
 const { useApiData } = await import('../composables/useApiData')
 const { ref: vueRef } = await import('vue')
 fetchResponses.set('/api/test/path1', { id: 1 })
 fetchResponses.set('/api/test/path2', { id: 2 })
 fetchDelay = 30

 // Use a Vue ref so the computed path updates reactively (this is how
 // real components use it — route.params.slug is a ref).
 const currentPath = vueRef('/test/path1')
 const { data } = useApiData(() => currentPath.value)

 // Wait for first fetch
 await new Promise<void>(resolve => {
  if (data.value?.id === 1) { resolve(); return }
  const stop = watch(data, val => {
   if (val?.id === 1) {
    stop()
    resolve()
   }
  })
 })
 await nextTick()
 assert.equal(data.value?.id, 1)

 // Change the ref — the watcher fires and re-fetches the new path.
 currentPath.value = '/test/path2'
 await new Promise<void>(resolve => {
  if (data.value?.id === 2) { resolve(); return }
  const stop = watch(data, val => {
   if (val?.id === 2) {
    stop()
    resolve()
   }
  })
 })
 await nextTick()
 assert.equal(data.value?.id, 2, 'Should fetch new path data')
 })

 test('handles null/undefined path gracefully', async () => {
 const { useApiData } = await import('../composables/useApiData')

 const { data, refreshing, error } = useApiData(() => null)

 await nextTick()

 assert.equal(data.value, null)
 assert.equal(refreshing.value, false)
 assert.equal(error.value, null)
 })
})