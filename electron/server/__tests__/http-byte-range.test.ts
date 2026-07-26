import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHttpByteRange } from '../lib/http-byte-range.js'

test('HTTP byte ranges preserve full-file requests', () => {
  assert.deepEqual(parseHttpByteRange(undefined, 1_000), { kind: 'full' })
})

test('HTTP byte ranges support exact, open-ended, and suffix requests', () => {
  assert.deepEqual(parseHttpByteRange('bytes=100-199', 1_000), { kind: 'partial', start: 100, end: 199 })
  assert.deepEqual(parseHttpByteRange('bytes=900-', 1_000), { kind: 'partial', start: 900, end: 999 })
  assert.deepEqual(parseHttpByteRange('bytes=-200', 1_000), { kind: 'partial', start: 800, end: 999 })
})

test('HTTP byte ranges clamp valid ends and reject unsafe requests', () => {
  assert.deepEqual(parseHttpByteRange('bytes=900-2000', 1_000), { kind: 'partial', start: 900, end: 999 })
  assert.deepEqual(parseHttpByteRange('bytes=1000-', 1_000), { kind: 'invalid' })
  assert.deepEqual(parseHttpByteRange('bytes=200-100', 1_000), { kind: 'invalid' })
  assert.deepEqual(parseHttpByteRange('bytes=0-1,4-5', 1_000), { kind: 'invalid' })
  assert.deepEqual(parseHttpByteRange('items=0-10', 1_000), { kind: 'invalid' })
})
