/**
 * The Channels list is served from the shared stale-while-revalidate store.
 *
 * ── What was at stake ──
 *
 * `pages/index.vue` used to read `/projects` with `cache: 'no-store'`, because
 * nothing else could make a changed list show up. Removing that flag is what
 * makes the page paint its last list at once on return — and it means the STORE
 * now has to answer for changes, not the flag.
 *
 * So the rule under test is the one the change depends on: a mutation that
 * changes WHICH channels exist must leave the stored list unusable, so the next
 * read goes to the network.
 *
 *   · create  — POST /projects
 *   · hide    — DELETE /projects/:slug  (the "Hide Channel (Keep Files)" button)
 *   · restore — POST /soft-deleted-projects/:slug/restore
 *
 * The hide case is the one that would silently rot: it is keyed on one project,
 * so the per-project invalidation rules never reach the list itself, and the
 * owner would keep seeing a channel he had just hidden.
 *
 * Every count below is pinned to a non-zero number and to WHICH list came back,
 * so "always returns the same answer" cannot pass (AGENTS.md §6).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'

let fetchCalls: Array<{ url: string; options: any }> = []
let fetchResponses: Map<string, any> = new Map()
/**
 * When set, reads of /api/projects park until the test releases them, so a
 * test can prove what happened BEFORE any answer existed — no wall-clock.
 */
let holdProjectReads = false
const parkedReads: Array<() => void> = []

;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
  fetchCalls.push({ url, options })
  if (holdProjectReads && url === '/api/projects' && !options?.method) {
    await new Promise<void>((resolve) => { parkedReads.push(resolve) })
  }
  const response = fetchResponses.get(url)
  if (response instanceof Error) throw response
  return response ?? []
}

const listReads = () => fetchCalls.filter(c => c.url === '/api/projects' && !c.options?.method)
const setList = (rows: Array<{ slug: string; name: string }>) => fetchResponses.set('/api/projects', rows)
const channel = (slug: string) => ({ slug, name: slug.toUpperCase() })

describe('the channels list is instant on return and still correct after a change', () => {
  beforeEach(async () => {
    fetchCalls = []
    fetchResponses.clear()
    holdProjectReads = false
    parkedReads.length = 0
    const api = await import('../composables/useApi')
    api._markBootReadyForTests()
    api._clearApiGetCacheForTests()
    const { _swrClearForTests } = await import('../utils/swrCache')
    _swrClearForTests()
  })

  test('a second read is handed the stored list while the refresh is still in flight', async () => {
    const { useApi } = await import('../composables/useApi')
    const { get } = useApi()

    setList([channel('alpha')])
    holdProjectReads = true

    // Cold read: there is nothing stored, so this cannot finish until the
    // network answers — and the test, not the clock, is what answers it.
    const cold = get<Array<{ slug: string }>>('/projects')
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(listReads().length, 1, 'the first read does go to the network')
    assert.equal(parkedReads.length, 1, 'and it is still waiting there')
    parkedReads.shift()!()
    const first = await cold
    assert.deepEqual(first.map(row => row.slug), ['alpha'])

    // Warm read: this one must NOT need an answer. The refresh it starts is
    // still parked, which is exactly the point — the page paints at once.
    const warm = get<Array<{ slug: string }>>('/projects')
    const second = await warm
    assert.deepEqual(second.map(row => row.slug), ['alpha'],
      'the stored list is what the page gets back, not a wait')
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(parkedReads.length, 1,
      'the refresh behind it is still in flight, so nothing awaited it')

    // …and that refresh lands when it lands, replacing the stored value.
    setList([channel('alpha'), channel('beta')])
    parkedReads.shift()!()
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(listReads().length, 2, 'two reads went out: one cold, one background')
    const third = await get<Array<{ slug: string }>>('/projects')
    assert.deepEqual(third.map(row => row.slug).sort(), ['alpha', 'beta'],
      'the background refresh is what replaces the stored list')
  })

  test('creating a channel invalidates the list: the next read is the network', async () => {
    const { useApi } = await import('../composables/useApi')
    const { get, post } = useApi()

    setList([channel('alpha')])
    await get('/projects')
    assert.equal(listReads().length, 1)

    setList([channel('alpha'), channel('beta')])
    await post('/projects', { name: 'Beta' })

    const after = await get<Array<{ slug: string }>>('/projects')
    assert.equal(listReads().length, 2, 'a create must cost a fresh read of the list')
    assert.deepEqual(after.map(row => row.slug).sort(), ['alpha', 'beta'],
      'the new channel has to be on the list the page then paints')
  })

  test('hiding a channel invalidates the list: the hidden one is gone', async () => {
    const { useApi } = await import('../composables/useApi')
    const { get, del } = useApi()

    setList([channel('alpha'), channel('beta')])
    await get('/projects')
    assert.equal(listReads().length, 1)

    // "Hide Channel (Keep Files)" in settings — a DELETE on the project itself.
    setList([channel('alpha')])
    await del('/projects/beta')

    const after = await get<Array<{ slug: string }>>('/projects')
    assert.equal(listReads().length, 2,
      'hiding a channel is keyed on that project alone, so it needs the explicit rule that reaches the list')
    assert.deepEqual(after.map(row => row.slug), ['alpha'],
      'a hidden channel still on the painted list is the whole defect this guards')
  })

  test('restoring a hidden channel invalidates the list it returns to', async () => {
    const { useApi } = await import('../composables/useApi')
    const { get, post } = useApi()

    setList([channel('alpha')])
    fetchResponses.set('/api/soft-deleted-projects', { projects: [channel('beta')] })
    await get('/soft-deleted-projects')
    await get('/projects')
    const readsBefore = listReads().length
    assert.equal(readsBefore, 1)

    setList([channel('alpha'), channel('beta')])
    await post('/soft-deleted-projects/beta/restore', {})

    const after = await get<Array<{ slug: string }>>('/projects')
    assert.equal(listReads().length, readsBefore + 1,
      'restoring must re-read the list, not serve the one without it')
    assert.deepEqual(after.map(row => row.slug).sort(), ['alpha', 'beta'])
  })
})

describe('the page reads the list through the store', () => {
  const homePage = readFileSync(
    fileURLToPath(new URL('../pages/index.vue', import.meta.url)), 'utf8',
  )

  test('the /projects read no longer opts out of the cache', () => {
    assert.match(homePage, /await get<any\[\]>\('\/projects'\)/,
      'the list must be read through the shared cache, which is what paints it at once')
    assert.doesNotMatch(homePage, /get<any\[\]>\('\/projects',\s*\{[^}]*no-store/,
      "cache: 'no-store' on /projects makes every visit a full wait again")
  })

  test('the page says where the list came from, next to the title', () => {
    assert.match(homePage, /<ApiDataStatus path="\/projects"/,
      'the freshness line belongs under the Channels heading, fed by the same entry the list is')
  })
})
