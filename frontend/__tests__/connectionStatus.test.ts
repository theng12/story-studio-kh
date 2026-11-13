import assert from 'node:assert/strict'
import test from 'node:test'
import { connectionStatus } from '../composables/useNetworkStatus.js'

test('a stopped Gateway is named, with its resolved address and a visible next step', () => {
  const status = connectionStatus(true, 'unreachable', 'http://127.0.0.1:8787')
  assert.equal(status.tone, 'offline')
  assert.equal(status.label, 'Gateway not reachable at http://127.0.0.1:8787')
  assert.match(status.hint, /Open the Gateway app/)
  // No address measured yet must not invent one.
  assert.equal(connectionStatus(true, 'unreachable').label, 'Gateway not reachable')
})

test('the local engine being down outranks anything said about the Gateway', () => {
  for (const gateway of ['reachable', 'unreachable', 'unknown'] as const) {
    const status = connectionStatus(false, gateway)
    assert.equal(status.tone, 'offline')
    assert.match(status.label, /engine not answering/)
    assert.ok(status.hint)
  }
})

test('connected and still-checking need no hint and never claim an outage', () => {
  assert.deepEqual(connectionStatus(true, 'reachable'), { tone: 'online', label: 'Gateway connected', hint: '' })
  const checking = connectionStatus(true, 'unknown')
  assert.equal(checking.tone, 'unknown')
  assert.equal(checking.hint, '')
  assert.doesNotMatch(checking.label, /not reachable|offline|unavailable/i)
})
