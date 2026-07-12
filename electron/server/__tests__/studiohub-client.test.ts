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
  hubSubmitJob,
  hubSubmitChatPacks,
  hubPollChatPacks,
} from '../lib/studiohub-client.js'
import { isConnectionError } from '../lib/endpoint-pool.js'

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

describe('hubSubmitJob fallback contract', () => {
  // A DOWN Hub must throw a message that endpoint-pool's isConnectionError()
  // recognises — that's what makes the image/chat providers fall back to the
  // direct pool instead of failing the job. (Uses a refused local port.)
  test('a dead Hub throws a connection-error the providers fall back on', async () => {
    let err: any
    try {
      await hubSubmitJob('http://127.0.0.1:1', undefined, {
        modality: 'image', model: 'x/y', items: [{ prompt: 'p' }],
      })
    } catch (e) { err = e }
    assert.ok(err, 'expected a throw')
    assert.equal(isConnectionError(err), true, `isConnectionError must match: ${err?.message}`)
  })
})

describe('durable Hub Chat packs', () => {
  test('submits packs and polls stable scene-id results', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    let polls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/chat/jobs')) {
        return new Response(JSON.stringify({ batch_id: 'chat-123', packs: 1, scenes: 2 }), { status: 201 })
      }
      polls++
      return new Response(JSON.stringify({
        id: 'chat-123', status: 'done', total_scenes: 2, completed_scenes: 2,
        packs: [{
          pack_id: 'visual-0001', scene_ids: ['s1', 's2'], state: 'done',
          results: [{ scene_id: 's2', text: 'second' }, { scene_id: 's1', text: 'first' }],
        }],
      }), { status: 200 })
    }) as typeof fetch
    try {
      const submitted = await hubSubmitChatPacks('http://hub:47873/', ' token ', {
        model: 'repo/model', kind: 'visual',
        packs: [{
          pack_id: 'visual-0001', scene_ids: ['s1', 's2'],
          messages: [{ role: 'user', content: 'Return both scene IDs.' }],
        }],
      })
      assert.equal(submitted.batch_id, 'chat-123')
      const final = await hubPollChatPacks('http://hub:47873/', 'token', submitted.batch_id)
      assert.equal(final.completed_scenes, 2)
      assert.deepEqual(final.packs[0]?.results?.map(r => r.scene_id), ['s2', 's1'])
      assert.equal(polls, 1)
      assert.equal(calls[0], 'http://hub:47873/api/hub/chat/jobs')
      assert.equal(calls[1], 'http://hub:47873/api/hub/chat/jobs/chat-123')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a dead Hub Chat queue preserves direct-fallback wording', async () => {
    await assert.rejects(
      () => hubSubmitChatPacks('http://127.0.0.1:1', undefined, {
        model: 'repo/model', kind: 'motion',
        packs: [{ pack_id: 'p1', scene_ids: ['s1'], messages: [{ role: 'user', content: 'x' }] }],
      }),
      /Connection error/i,
    )
  })
})
