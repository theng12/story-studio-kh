/**
 * v1.0.528 — Studio Hub client pure helpers (Phase 1).
 *
 * These build the Hub URLs and auth headers that the local providers use when
 * `local_backend === 'hub'`. trimHubUrl is the same double-slash guard that
 * bit us in the direct pool (v1.0.527 sibling-endpoint 404) — a trailing slash
 * must never survive into a joined path.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  trimHubUrl,
  hubChatRootBase,
  hubApiBase,
  hubHeaders,
  isLoopbackHub,
} from '../lib/studiohub-client.js'

describe('trimHubUrl', () => {
  test('strips trailing slashes and whitespace', () => {
    assert.equal(trimHubUrl('http://127.0.0.1:47873/'), 'http://127.0.0.1:47873')
    assert.equal(trimHubUrl('  http://hub:47873///  '), 'http://hub:47873')
    assert.equal(trimHubUrl('http://hub:47873'), 'http://hub:47873')
  })
  test('empty/degenerate input', () => {
    assert.equal(trimHubUrl(''), '')
    assert.equal(trimHubUrl('   '), '')
  })
})

describe('hubChatRootBase', () => {
  test('appends the gateway path with no double slash (even w/ trailing slash)', () => {
    // chatstudioApiBase later appends /v1 → the documented gateway path
    // {hub}/studio/chat/v1/chat/completions
    assert.equal(hubChatRootBase('http://127.0.0.1:47873'), 'http://127.0.0.1:47873/studio/chat')
    assert.equal(hubChatRootBase('http://127.0.0.1:47873/'), 'http://127.0.0.1:47873/studio/chat')
  })
})

describe('hubApiBase', () => {
  test('builds the batch-jobs API base', () => {
    assert.equal(hubApiBase('http://127.0.0.1:47873/'), 'http://127.0.0.1:47873/api/hub')
  })
})

describe('hubHeaders', () => {
  test('token → X-Hub-Token header; empty → no header', () => {
    assert.deepEqual(hubHeaders('abc123'), { 'X-Hub-Token': 'abc123' })
    assert.deepEqual(hubHeaders('  tok  '), { 'X-Hub-Token': 'tok' })
    assert.deepEqual(hubHeaders(''), {})
    assert.deepEqual(hubHeaders(undefined), {})
    assert.deepEqual(hubHeaders(null), {})
  })
})

describe('isLoopbackHub', () => {
  test('true for loopback hosts (token-exempt)', () => {
    assert.equal(isLoopbackHub('http://127.0.0.1:47873'), true)
    assert.equal(isLoopbackHub('http://localhost:47873'), true)
    assert.equal(isLoopbackHub('http://[::1]:47873'), true)
  })
  test('false for tailnet / remote hosts (token needed)', () => {
    assert.equal(isLoopbackHub('http://100.66.3.3:47873'), false)
    assert.equal(isLoopbackHub('http://hub.tailnet.ts.net:47873'), false)
  })
})
