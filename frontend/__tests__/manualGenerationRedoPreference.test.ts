import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { _clearApiGetCacheForTests } from '../composables/useApi.js'

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type FetchHandler = (url: string) => unknown | Promise<unknown>
const requests: FetchHandler[] = []
const urls: string[] = []
;(globalThis as any).$fetch = async (url: string) => {
  urls.push(url)
  const handler = requests.shift()
  if (!handler) throw new Error(`Unexpected request: ${url}`)
  return handler(url)
}

let composable: typeof import('../composables/useManualGenerationRedoPreference.js') | undefined
let importError: unknown
try {
  composable = await import('../composables/useManualGenerationRedoPreference.js')
} catch (error) {
  importError = error
}

function usePreference() {
  assert.ifError(importError)
  assert.ok(composable?.useManualGenerationRedoPreference)
  return composable.useManualGenerationRedoPreference()
}

beforeEach(() => {
  requests.length = 0
  urls.length = 0
  _clearApiGetCacheForTests()
})

test('only the exact stored true enables manual generation redo; malformed and failed reads stay off', async () => {
  const preference = usePreference()
  requests.push(() => ({ enabled: true }))
  assert.equal(await preference.load('project-a'), true)
  assert.equal(preference.enabled.value, true)
  assert.deepEqual(urls, ['/api/app-settings/manual-generation-redo'])

  for (const reply of [{ enabled: 1 }, { enabled: 'true' }, {}, null]) {
    requests.push(() => reply)
    assert.equal(await preference.load(`scope-${String((reply as any)?.enabled)}`), false)
    assert.equal(preference.enabled.value, false)
  }
  requests.push(() => { throw new Error('offline') })
  assert.equal(await preference.load('offline'), false)
  assert.equal(preference.enabled.value, false)
})

test('a scope change clears synchronously and stale replies cannot re-enable the new scope', async () => {
  const preference = usePreference()
  const oldReply = defer<unknown>()
  const newReply = defer<unknown>()
  requests.push(() => oldReply.promise, () => newReply.promise)

  const oldLoad = preference.load('project-a')
  const newLoad = preference.load('project-b')
  assert.equal(preference.enabled.value, false)
  newReply.resolve({ enabled: true })
  assert.equal(await newLoad, true)
  assert.equal(preference.enabled.value, true)
  oldReply.resolve({ enabled: true })
  assert.equal(await oldLoad, false, 'a stale load reports false even when the current scope is enabled')
  assert.equal(preference.enabled.value, true)
})

test('reset invalidates pending work and returns to the fail-closed state', async () => {
  const preference = usePreference()
  const reply = defer<unknown>()
  requests.push(() => reply.promise)
  const pending = preference.load('project-a')
  preference.reset()
  reply.resolve({ enabled: true })

  assert.equal(await pending, false)
  assert.equal(preference.enabled.value, false)
})
