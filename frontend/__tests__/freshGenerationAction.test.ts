import assert from 'node:assert/strict'
import test from 'node:test'
import { useFreshGenerationAction } from '../composables/useFreshGenerationAction'

function withBrowserCrypto<T>(value: Crypto, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value })
  try { return run() }
  finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else Reflect.deleteProperty(globalThis, 'crypto')
  }
}

test('uses the browser native UUID method with its crypto receiver', () => {
  const native = {
    randomUUID(this: unknown) {
      assert.equal(this, native)
      return '00112233-4455-4677-8899-aabbccddeeff'
    },
    getRandomValues() { throw new Error('fallback must not run') },
  } as unknown as Crypto

  withBrowserCrypto(native, () => {
    assert.equal(useFreshGenerationAction().begin({ episode: 'EP0001' }), '00112233-4455-4677-8899-aabbccddeeff')
  })
})

test('uses getRandomValues for an RFC 4122 UUID when randomUUID is unavailable', () => {
  let calls = 0
  const browserCrypto = {
    getRandomValues(this: unknown, bytes: Uint8Array) {
      assert.equal(this, browserCrypto)
      calls++
      for (let index = 0; index < bytes.length; index++) bytes[index] = index + calls - 1
      return bytes
    },
  } as unknown as Crypto

  withBrowserCrypto(browserCrypto, () => {
    const action = useFreshGenerationAction()
    const id = action.begin({ episode: 'EP0001' })
    assert.equal(id, '00010203-0405-4607-8809-0a0b0c0d0e0f')
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(action.begin({ episode: 'EP0001' }), id, 'the unresolved scope replays one action identity')
    assert.equal(calls, 1)
    const changed = action.begin({ episode: 'EP0002' })
    assert.notEqual(changed, id, 'a changed scope gets a fresh identity')
    action.complete(changed)
    assert.notEqual(action.begin({ episode: 'EP0002' }), changed, 'a confirmed action gets a fresh identity next time')
    assert.equal(calls, 3)
  })
})

test('fails before recording an action when secure browser entropy is unavailable', () => {
  withBrowserCrypto({} as Crypto, () => {
    const action = useFreshGenerationAction()
    assert.throws(
      () => action.begin({ episode: 'EP0001' }),
      (error: any) => error?.data?.detail === 'This browser cannot create a secure request identity. Open Story Studio in a secure browser connection and try again.',
    )
    assert.equal(action.hasPending.value, false)
  })
})

test('an unresolved action keeps its id for the same scope and changes it for a deliberate scope edit', () => {
  const action = useFreshGenerationAction()
  const first = action.begin({ episode: 'EP0001', model: 'voice-a' })
  assert.equal(action.begin({ episode: 'EP0001', model: 'voice-a' }), first)
  assert.equal(action.isRetry({ episode: 'EP0001', model: 'voice-a' }), true)

  const changed = action.begin({ episode: 'EP0001', model: 'voice-b' })
  assert.notEqual(changed, first)
  assert.equal(action.isRetry({ episode: 'EP0001', model: 'voice-a' }), false)
  assert.equal(action.isRetry({ episode: 'EP0001', model: 'voice-b' }), true)
})

test('independent row targets retain their own unresolved actions and success clears only its action', () => {
  const action = useFreshGenerationAction()
  const first = action.begin({ words: 500 }, 'chapter:1')
  const second = action.begin({ words: 700 }, 'chapter:2')
  assert.equal(action.begin({ words: 500 }, 'chapter:1'), first)
  assert.equal(action.begin({ words: 700 }, 'chapter:2'), second)

  action.complete(first)
  assert.equal(action.isRetry({ words: 500 }, 'chapter:1'), false)
  assert.equal(action.isRetry({ words: 700 }, 'chapter:2'), true)
  assert.equal(action.hasPending.value, true)
  action.complete(second)
  assert.equal(action.hasPending.value, false)
})
