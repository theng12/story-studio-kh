/**
 * Tests for the local-modal endpoint pool (lib/endpoint-pool.ts).
 *
 * Covers the resilience guarantees the v1.0.304 fixes depend on:
 *   - isConnectionError recognises the strings our providers throw (incl. the
 *     LM Studio pre-flight probe's "unreachable" message) so failover triggers.
 *   - runOnPool fails over to another endpoint on a connection error, and
 *     rethrows a content error immediately (no wasted failover).
 *   - createDispatcher picks least-busy and markDown takes an endpoint out of
 *     rotation (the self-healing TTL recovery is exercised separately).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isConnectionError, runOnPool, createDispatcher, parseEndpoints,
  parseEnabledEndpoints, setDisabledEndpoints, isEndpointEnabled,
} from '../lib/endpoint-pool.js'

describe('endpoint-pool', () => {
  test('isConnectionError matches the strings providers actually throw', () => {
    for (const m of [
      'ECONNREFUSED 127.0.0.1:1234',
      'fetch failed',
      'request to http://x timed out',
      'socket hang up',
      'ENOTFOUND theng-macmini-m1',
      'EHOSTUNREACH',
      'host unreachable',
      // The LM Studio pre-flight probe's thrown message (v1.0.304):
      'LM Studio at http://mac:1234 is unreachable: Timed out reaching LM Studio. Connection error — failing over if other endpoints are configured.',
    ]) {
      assert.equal(isConnectionError(new Error(m)), true, `should match: ${m}`)
    }
  })

  test('isConnectionError does NOT match content errors (no wasted failover)', () => {
    for (const m of [
      'LM Studio at http://mac:1234 has no model "gemma" loaded.',
      'No models loaded',
      'invalid JSON in response',
      '400 Bad Request',
    ]) {
      assert.equal(isConnectionError(new Error(m)), false, `should NOT match: ${m}`)
    }
  })

  test('runOnPool fails over to a healthy endpoint on a connection error', async () => {
    const d = createDispatcher(['http://dead:1234', 'http://live:1234'])
    const tried: string[] = []
    const result = await runOnPool(d, 'http://dead:1234', async (ep) => {
      tried.push(ep)
      if (ep.includes('dead')) throw new Error('ECONNREFUSED')
      return 'ok-from-live'
    })
    assert.equal(result, 'ok-from-live')
    assert.ok(tried.includes('http://dead:1234'), 'tried the dead endpoint first')
    assert.ok(tried.includes('http://live:1234'), 'failed over to the live endpoint')
    // The dead endpoint is taken out of rotation.
    assert.equal(d.liveCount(), 1)
  })

  test('runOnPool rethrows a content error immediately (no failover)', async () => {
    const d = createDispatcher(['http://a:1234', 'http://b:1234'])
    let calls = 0
    await assert.rejects(
      () => runOnPool(d, 'http://a:1234', async () => { calls++; throw new Error('No models loaded') }),
      /No models loaded/,
    )
    assert.equal(calls, 1, 'content error should NOT fan out across the pool')
    assert.equal(d.liveCount(), 2, 'no endpoint marked down on a content error')
  })

  test('runOnPool throws the last connection error when all endpoints are down', async () => {
    const d = createDispatcher(['http://a:1234', 'http://b:1234'])
    await assert.rejects(
      () => runOnPool(d, 'http://a:1234', async () => { throw new Error('fetch failed') }),
      /fetch failed/,
    )
    assert.equal(d.liveCount(), 0, 'all endpoints marked down')
  })

  test('single-endpoint setup (no dispatcher) is a pass-through', async () => {
    const out = await runOnPool(null, 'http://only:1234', async (ep) => ep)
    assert.equal(out, 'http://only:1234')
  })

  test('createDispatcher picks least-busy and markDown removes from rotation', () => {
    const d = createDispatcher(['http://a:1234', 'http://b:1234', 'http://c:1234'])
    assert.equal(d.size, 3)
    assert.equal(d.liveCount(), 3)
    const first = d.pick()           // all 0 in-flight → first in list
    assert.equal(first, 'http://a:1234')
    const second = d.pick()          // a now has 1 in-flight → next least-busy
    assert.notEqual(second, 'http://a:1234')
    d.markDown('http://a:1234')
    assert.equal(d.liveCount(), 2, 'marked-down endpoint is out of rotation')
  })

  test('parseEndpoints splits comma/space lists and strips trailing slashes', () => {
    assert.deepEqual(
      parseEndpoints('http://a:1234/, http://b:1234  http://c:1234/'),
      ['http://a:1234', 'http://b:1234', 'http://c:1234'],
    )
    assert.deepEqual(parseEndpoints(''), [])
    assert.deepEqual(parseEndpoints(null), [])
  })

  test('parseEnabledEndpoints drops manually-disabled endpoints, keeps the rest', () => {
    // Distinct ports per provider make the union safe; we mix two providers.
    setDisabledEndpoints('imagestudio', ['http://b:47868'])
    setDisabledEndpoints('lmstudio', ['http://x:1234/'])  // trailing slash normalised

    const stored = 'http://a:47868, http://b:47868, http://c:47868'
    assert.deepEqual(
      parseEnabledEndpoints(stored),
      ['http://a:47868', 'http://c:47868'],
      'the disabled imagestudio endpoint is filtered out',
    )
    assert.equal(isEndpointEnabled('http://b:47868'), false)
    assert.equal(isEndpointEnabled('http://a:47868'), true)
    // Trailing-slash variants of a disabled url are still recognised as off.
    assert.equal(isEndpointEnabled('http://x:1234'), false)

    // Re-enabling one provider clears only its set (union rebuilt).
    setDisabledEndpoints('imagestudio', [])
    assert.deepEqual(parseEnabledEndpoints(stored), ['http://a:47868', 'http://b:47868', 'http://c:47868'])
    assert.equal(isEndpointEnabled('http://x:1234'), false, 'lmstudio set still applies')

    // Clean up so we don't leak state into other test files sharing the module.
    setDisabledEndpoints('lmstudio', [])
  })

  test('parseEnabledEndpoints with no disabled set is identical to parseEndpoints', () => {
    setDisabledEndpoints('imagestudio', [])
    setDisabledEndpoints('lmstudio', [])
    setDisabledEndpoints('voicestudio', [])
    const stored = 'http://a:1234, http://b:1234'
    assert.deepEqual(parseEnabledEndpoints(stored), parseEndpoints(stored))
  })
})
