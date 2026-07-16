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
  hubBatchArtifactUrl,
  hubHeaders,
  isLoopbackHub,
  hubSubmitJob,
  hubSubmitChatPacks,
  hubPollChatPacks,
  hubCancelBatch,
  hubPollBatch,
  hubFleetStatus,
  hubSharedVoices,
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

describe('hubBatchArtifactUrl', () => {
  test('uses the authenticated Hub proxy instead of a raw worker URL', () => {
    assert.equal(
      hubBatchArtifactUrl('http://hub:47873/', 'batch 123', 7),
      'http://hub:47873/api/hub/jobs/batch%20123/items/7/artifact',
    )
  })
})

describe('Hub item persistence callbacks', () => {
  test('retries a completed item until the caller durably saves it', async () => {
    const originalFetch = globalThis.fetch
    let saveAttempts = 0
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'batch-1', queued: 0, running: 0, done: 1, error: 0,
      items: [{ index: 0, state: 'done', artifact_url: 'http://worker/image' }],
    }), { status: 200 })) as typeof fetch
    try {
      const result = await hubPollBatch('http://hub:47873', undefined, 'batch-1', {
        onItemDone: async () => {
          saveAttempts++
          if (saveAttempts === 1) throw new Error('temporary disk failure')
        },
      })
      assert.equal(result.done, 1)
      assert.equal(saveAttempts, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('reconnects to an accepted batch instead of starting duplicate fallback work', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) throw new Error('temporary network loss')
      return new Response(JSON.stringify({
        id: 'batch-1', queued: 0, running: 0, done: 1, error: 0,
        items: [{ index: 0, state: 'done', artifact_url: 'http://worker/image' }],
      }), { status: 200 })
    }) as typeof fetch
    try {
      const result = await hubPollBatch('http://hub:47873', undefined, 'batch-1', {
        reconnectDelayMs: 1,
      })
      assert.equal(result.done, 1)
      assert.equal(calls, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
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

describe('Hub fleet readiness', () => {
  test('reports readiness without returning the loopback fleet credential', async () => {
    const originalFetch = globalThis.fetch
    let requested = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input)
      return new Response(JSON.stringify({
        fleet_token_set: true,
        token: 'must-not-leave-the-server',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const status = await hubFleetStatus('http://127.0.0.1:47873', '')
      assert.equal(requested, 'http://127.0.0.1:47873/api/hub/fleet')
      assert.deepEqual(status, { ok: true, fleetTokenSet: true })
      assert.equal('token' in status, false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('turns a rejected remote credential into an actionable status', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('no', { status: 401 })) as typeof fetch
    try {
      assert.deepEqual(
        await hubFleetStatus('http://100.64.0.10:47873', 'wrong'),
        { ok: false, fleetTokenSet: false, error: 'Hub access token was rejected' },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Hub shared voice inventory', () => {
  test('loads canonical voice ids and synchronization targets', async () => {
    const originalFetch = globalThis.fetch
    let requested = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input)
      return new Response(JSON.stringify({
        voices: [{
          id: '074743daa991', name: 'Vincent', language: 'en',
          targets: [{ studio_id: 'voice@mac-a', machine: 'mac-a', status: 'synced' }],
          sync: { total: 1, synced: 1 },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const voices = await hubSharedVoices('http://hub:47873/', 'token')
      assert.equal(requested, 'http://hub:47873/api/hub/shared-voices')
      assert.equal(voices[0]?.id, '074743daa991')
      assert.equal(voices[0]?.targets?.[0]?.status, 'synced')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('hubSubmitJob strict transport contract', () => {
  // A DOWN Hub must throw a clearly classified connection error. Providers
  // report it and keep the configured Hub route; they do not switch to Direct.
  test('a dead Hub throws a classified connection error', async () => {
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

describe('Hub cancellation acknowledgement', () => {
  test('generation cancellation reaches the exact Hub batch', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method?: string }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method })
      return new Response(JSON.stringify({ ok: true, running_signalled: 1 }), { status: 200 })
    }) as typeof fetch
    try {
      await hubCancelBatch('http://hub:47873/', ' token ', 'batch 123')
      assert.deepEqual(calls, [{
        url: 'http://hub:47873/api/hub/jobs/batch%20123', method: 'DELETE',
      }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('poll cancellation does not silently discard a refused Hub cancel', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('worker unavailable', { status: 503 })
    }) as typeof fetch
    try {
      await assert.rejects(
        () => hubPollBatch('http://hub:47873', undefined, 'batch-1', {
          isCancelled: () => true,
        }),
        /Cancelled by user locally.*did not acknowledge cancellation/i,
      )
      assert.equal(calls, 3)
    } finally {
      globalThis.fetch = originalFetch
    }
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

  test('reconnects to accepted prompt packs without direct cloud fallback', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) throw new Error('temporary network loss')
      return new Response(JSON.stringify({
        id: 'chat-123', status: 'partial', total_scenes: 2, completed_scenes: 1,
        packs: [{
          pack_id: 'visual-0001', scene_ids: ['s1', 's2'], state: 'partial',
          missing_scene_ids: ['s2'], results: [{ scene_id: 's1', text: 'saved' }],
        }],
      }), { status: 200 })
    }) as typeof fetch
    try {
      const result = await hubPollChatPacks('http://hub:47873', undefined, 'chat-123', {
        reconnectDelayMs: 1,
      })
      assert.equal(result.completed_scenes, 1)
      assert.equal(result.packs[0]?.results?.[0]?.scene_id, 's1')
      assert.equal(calls, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a dead Hub Chat queue reports a strict Hub connection failure', async () => {
    await assert.rejects(
      () => hubSubmitChatPacks('http://127.0.0.1:1', undefined, {
        model: 'repo/model', kind: 'motion',
        packs: [{ pack_id: 'p1', scene_ids: ['s1'], messages: [{ role: 'user', content: 'x' }] }],
      }),
      /Connection error/i,
    )
  })
})
