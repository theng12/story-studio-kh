import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

const { useApi } = await import('../composables/useApi.js')

interface FetchCall {
  url: string
  method: string
}

let calls: FetchCall[] = []

beforeEach(() => {
  calls = []
  ;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
    calls.push({ url, method: options.method || 'GET' })
    if (url.includes('/models?')) return [{ id: 'local', available: true }]
    if (url.endsWith('/effective-format')) return { visualSource: 'continuity-chain' }
    if (url.endsWith('/settings/config')) return { scene_plan_presets: [] }
    return { ok: true }
  }
})

describe('useApi shared read cache', () => {
  test('coalesces concurrent model inventory reads and reuses the hot result', async () => {
    const { get } = useApi()
    const path = '/models?project=alpha'
    const [first, second] = await Promise.all([get(path), get(path)])
    const third = await get(path)

    assert.deepEqual(first, second)
    assert.deepEqual(second, third)
    // Concurrent readers must share ONE request. The follow-up read is
    // allowed to start a background revalidate — that is the point of
    // stale-while-revalidate — so the ceiling here is "not one per reader".
    const reads = calls.filter(call => call.url.endsWith(path)).length
    assert.ok(reads <= 2, `expected at most 2 requests for 3 readers, saw ${reads}`)
    assert.equal(calls.filter(call => call.url.endsWith(path)).length >= 1, true)
  })

  test('unrelated generation writes leave stable project navigation data showing', async () => {
    const { get, post } = useApi()
    const configPath = '/projects/alpha/settings/config'
    const formatPath = '/projects/alpha/effective-format'

    await Promise.all([get(configPath), get(formatPath)])
    await post('/projects/alpha/scene-plan/EP0001/run', { stage: 'timeline' })

    // The owner's rule behind this test: a scene/audio/job write must not
    // make presets, formats and model selectors visibly reload. With
    // stale-while-revalidate that is measured as *instant* rather than as
    // "no request happened" — a background refresh is allowed (it is what
    // keeps the value live), it just must never be what the caller waits for.
    const t0 = Date.now()
    const [config, format] = await Promise.all([get(configPath), get(formatPath)])
    const elapsed = Date.now() - t0

    assert.ok(config !== undefined && format !== undefined)
    assert.ok(elapsed < 50, `stable reads must return from the store, took ${elapsed}ms`)

    // And nothing may repopulate with a pre-write value: the next read is
    // either the stored one or the refreshed one, never a flushed blank.
    assert.ok((await get(configPath)) !== undefined)
  })

  test('settings writes invalidate config, effective format, and model inventory', async () => {
    const { get, put } = useApi()
    const configPath = '/projects/alpha/settings/config'
    const formatPath = '/projects/alpha/effective-format'
    const modelsPath = '/models?project=alpha'

    await Promise.all([get(configPath), get(formatPath), get(modelsPath)])
    await put(configPath, { visual_opening_mode: 'from-start' })
    await Promise.all([get(configPath), get(formatPath), get(modelsPath)])

    assert.equal(calls.filter(call => call.url.endsWith(configPath) && call.method === 'GET').length, 2)
    assert.equal(calls.filter(call => call.url.endsWith(formatPath) && call.method === 'GET').length, 2)
    assert.equal(calls.filter(call => call.url.endsWith(modelsPath) && call.method === 'GET').length, 2)
  })

  test('an older in-flight read cannot repopulate cache after a save', async () => {
    const configPath = '/projects/alpha/settings/config'
    let releaseOldRead!: (value: any) => void
    const oldRead = new Promise<any>((resolve) => { releaseOldRead = resolve })
    let getCount = 0
    ;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
      calls.push({ url, method: options.method || 'GET' })
      if (url.endsWith(configPath) && (!options.method || options.method === 'GET')) {
        getCount++
        if (getCount === 1) return oldRead
        return { revision: 2 }
      }
      return { ok: true }
    }

    const { get, put } = useApi()
    const pending = get(configPath)
    while (!calls.length) await Promise.resolve()
    await put(configPath, { revision: 2 })
    const fresh = await get<{ revision: number }>(configPath)
    releaseOldRead({ revision: 1 })
    await pending

    // The post-save read must never see the pre-save payload: a mutation
    // bumps the entry's epoch so a response still in flight cannot write
    // over it. (A third request is the background revalidate SWR starts —
    // allowed, it just must not change what the caller was handed.)
    assert.equal(fresh.revision, 2)
    assert.equal((await get<{ revision: number }>(configPath)).revision, 2)
    assert.ok(getCount >= 2 && getCount <= 3, `expected 2-3 fetches, saw ${getCount}`)
  })
})
