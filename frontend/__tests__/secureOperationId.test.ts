import assert from 'node:assert/strict'
import { test } from 'node:test'
import { secureOperationId } from '../composables/useFreshGenerationAction.ts'

/**
 * The one request identity every paid/queued action uses.
 *
 * `crypto.randomUUID` is secure-context-only, so a plain-HTTP connection (the
 * shop mini on a LAN address) has `getRandomValues` but not it. Reported
 * 2026-10-17: Scene Review's Finish refused on HTTP with "Restart Story Studio"
 * before it ever POSTed. These pin the branch that matters and the refusal that
 * must stay truthful when no CSPRNG exists at all.
 */

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function withCrypto<T>(fake: unknown, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true, writable: true })
  try {
    return run()
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else delete (globalThis as any).crypto
  }
}

test('randomUUID is used when the browser has it', () => {
  const id = withCrypto({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }, () => secureOperationId())
  assert.equal(id, '11111111-2222-4333-8444-555555555555')
})

test('no randomUUID over plain HTTP still produces an RFC 4122 v4 id from getRandomValues', () => {
  const calls: Uint8Array[] = []
  const fake = {
    getRandomValues: (bytes: Uint8Array) => {
      calls.push(bytes)
      for (let index = 0; index < bytes.length; index++) bytes[index] = index
      return bytes
    },
  }
  const id = withCrypto(fake, () => secureOperationId())
  assert.match(id, V4, 'the HTTP case must mint a v4 UUID, not refuse')
  assert.equal(id, '00010203-0405-4607-8809-0a0b0c0d0e0f')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 16, 'a full 128-bit identity, not a shorter guess')
})

test('with neither API the refusal is truthful and names the cause, with no restart or connection advice', () => {
  assert.throws(() => withCrypto({}, () => secureOperationId()), (error: any) => {
    const detail = String(error?.data?.detail || error?.message || '')
    assert.match(detail, /cannot create a secure request identity/i)
    assert.match(detail, /nothing was sent/i)
    assert.ok(!/restart/i.test(detail), 'no restart advice')
    assert.ok(!/connection|settings|secure browser|browser security/i.test(detail), 'no connection or settings advice')
    return true
  })
})

test('an incomplete crypto object is refused, not silently downgraded to Math.random or a clock value', () => {
  for (const fake of [{}, { getRandomValues: 'nope' }, { randomUUID: 'nope' }]) {
    assert.throws(() => withCrypto(fake, () => secureOperationId()), /secure request identity/i)
  }
})
