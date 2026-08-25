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
  isConnectionError, isModelNotReadyError, isInferenceFailureError, isFailoverableError,
  runOnPool, createDispatcher, parseEndpoints,
  parseEnabledEndpoints, setDisabledEndpoints, isEndpointEnabled,
} from '../lib/endpoint-pool.js'

describe('endpoint-pool', () => {
  test('isConnectionError matches the strings providers actually throw', () => {
    for (const m of [
      'ECONNREFUSED 127.0.0.1:1234',
      'fetch failed',
      'request to http://x timed out',
      'socket hang up',
      'ENOTFOUND my-mac-m1',
      'EHOSTUNREACH',
      'host unreachable',
      // The LM Studio pre-flight probe's thrown message (v1.0.304):
      'LM Studio at http://mac:1234 is unreachable: Timed out reaching LM Studio. Connection error — failing over if other endpoints are configured.',
    ]) {
      assert.equal(isConnectionError(new Error(m)), true, `should match: ${m}`)
    }
  })

  test('isConnectionError does NOT match true content errors (no wasted failover)', () => {
    for (const m of [
      'invalid JSON in response',
      '400 Bad Request',
      // v1.0.318 — "no model loaded" / "not fully cached" used to be content
      // errors here but moved to isModelNotReadyError below (still NOT matched
      // by isConnectionError — failover-decision uses isFailoverableError now).
    ]) {
      assert.equal(isConnectionError(new Error(m)), false, `should NOT match: ${m}`)
    }
  })

  // v1.0.318 — model-not-ready (per-endpoint capability) failover.
  test('isModelNotReadyError matches the messages providers actually throw when the model is missing', () => {
    for (const m of [
      // Voice Studio 409 — the TN1611 Kokoro case the user reported:
      'Voice Studio submit failed (409): {"detail":"Model hexgrad/Kokoro-82M is not fully cached. Download it from the Models tab first."}',
      // LM Studio's friendly wraps + the upstream variants:
      'LM Studio at http://mac:1234 has no model "gemma-3-4b" loaded — failing over to another endpoint in the pool.',
      'No models loaded',
      'model_not_found',
      'The model is not yet loaded',
    ]) {
      assert.equal(isModelNotReadyError(new Error(m)), true, `should match: ${m}`)
    }
  })

  test('isModelNotReadyError does NOT match unrelated errors', () => {
    for (const m of [
      'ECONNREFUSED 127.0.0.1:1234',
      'invalid JSON in response',
      '400 Bad Request: prompt too long',
    ]) {
      assert.equal(isModelNotReadyError(new Error(m)), false, `should NOT match: ${m}`)
    }
  })

  test('isFailoverableError is the union of connection + model-not-ready + inference-failure errors', () => {
    assert.equal(isFailoverableError(new Error('ECONNREFUSED')), true, 'connection')
    assert.equal(isFailoverableError(new Error('not fully cached')), true, 'model-not-ready')
    assert.equal(isFailoverableError(new Error("didn't produce a wav file")), true, 'inference-failure')
    assert.equal(isFailoverableError(new Error('400 Bad Request')), false, 'real content error')
  })

  // v1.0.320 — per-endpoint inference failure (the EP0002 mlx-audio case).
  test('isInferenceFailureError matches the EP0002 mlx-audio "no wav file" failure', () => {
    for (const m of [
      // The exact error string the user hit on TN0002/EP0002 — one Mac in a
      // 5-Mac pool randomly failed to write its wav out:
      'Voice Studio job failed: RuntimeError: mlx-audio didn\'t produce a wav file. Temp dir: /var/folders/c7/.../mlxaudio_kokoro-mlx_4e2775556fc4_7xlc_u9v',
      // Likely close-relatives — same family of "inference ran but produced no output":
      'Voice Studio job failed: failed to generate audio',
      'wav file not found',
      'produced no output',
      'no audio produced for this section',
    ]) {
      assert.equal(isInferenceFailureError(new Error(m)), true, `should match: ${m}`)
    }
  })

  test('isInferenceFailureError does NOT match real content errors (prompt issues etc.)', () => {
    for (const m of [
      '400 Bad Request: prompt too long',
      'Voice "xx_unknown" not found in voicepack',
      'ECONNREFUSED 127.0.0.1:47870',
      'not fully cached',
    ]) {
      assert.equal(isInferenceFailureError(new Error(m)), false, `should NOT match: ${m}`)
    }
  })

  test('runOnPool fails over on the EP0002 "didn\'t produce a wav file" runtime', async () => {
    // v1.0.321 — random tie-break means pick() might land on the healthy Mac
    // first (chunk succeeds with no failover) or the glitched one first (fails
    // over). Both outcomes are correct; run trials and check the invariant.
    let sawGlitchedPicked = false
    for (let trial = 0; trial < 30; trial++) {
      const d = createDispatcher([
        'http://glitched-mac:47870',
        'http://healthy-mac:47870',
      ])
      const tried: string[] = []
      const result = await runOnPool(d, 'http://healthy-mac:47870', async (ep) => {
        tried.push(ep)
        if (ep.includes('glitched')) {
          throw new Error(
            "Voice Studio job failed: RuntimeError: mlx-audio didn't produce a wav file. Temp dir: /var/folders/c7/.../mlxaudio_kokoro-mlx_x.tmp",
          )
        }
        return 'rendered-on-healthy-mac'
      })
      assert.equal(result, 'rendered-on-healthy-mac', 'always succeeds — healthy Mac renders the chunk')
      if (tried.includes('http://glitched-mac:47870')) {
        sawGlitchedPicked = true
        assert.equal(d.liveCount(), 1, 'glitched Mac marked down once it was tried')
      }
    }
    // Across 30 fresh dispatchers, the random tie-break must have picked the
    // glitched endpoint first at least once (otherwise the failover path is
    // never exercised — and that's what this whole test is for).
    assert.ok(sawGlitchedPicked, 'random tie-break should sometimes pick the glitched Mac first')
  })

  test('runOnPool fails over to a healthy endpoint on a connection error', async () => {
    // v1.0.321 — random tie-break means pick() might land on the live endpoint
    // first (in which case the dead one is never touched). Run multiple trials
    // so we exercise both pick orders and check the invariant: the call always
    // succeeds, the dead endpoint never RETURNS, and when it IS picked, the
    // pool fails over.
    let sawDeadPicked = false
    for (let trial = 0; trial < 30; trial++) {
      const d = createDispatcher(['http://dead:1234', 'http://live:1234'])
      const tried: string[] = []
      const result = await runOnPool(d, 'http://dead:1234', async (ep) => {
        tried.push(ep)
        if (ep.includes('dead')) throw new Error('ECONNREFUSED')
        return 'ok-from-live'
      })
      assert.equal(result, 'ok-from-live', 'always succeeds (failover catches the dead one)')
      assert.ok(tried.includes('http://live:1234'), 'live endpoint must be tried')
      if (tried.includes('http://dead:1234')) {
        sawDeadPicked = true
        // When the dead endpoint IS picked, it must be marked down after.
        assert.equal(d.liveCount(), 1, 'dead endpoint taken out of rotation when tried')
      }
    }
    // Across 30 trials with random tie-break we must have hit the dead-first
    // path at least once (probability of 30 all-live-first picks ≈ 1e-9).
    assert.ok(sawDeadPicked, 'random tie-break should sometimes pick the dead endpoint first')
  })

  // v1.0.318 — the user's TN1611 Kokoro scenario: 5 endpoints online, 3 with
  // the model missing. Before this fix, every chunk that landed on a missing-
  // model Mac died with no retry. Now it fails over to one that has it.
  test('runOnPool fails over on "model not fully cached" (Voice Studio 409)', async () => {
    const d = createDispatcher([
      'http://kokoro-missing-1:47870',
      'http://kokoro-missing-2:47870',
      'http://kokoro-loaded:47870',
    ])
    const tried: string[] = []
    const result = await runOnPool(d, 'http://kokoro-loaded:47870', async (ep) => {
      tried.push(ep)
      if (ep.includes('missing')) {
        throw new Error(
          'Voice Studio submit failed (409): {"detail":"Model hexgrad/Kokoro-82M is not fully cached. Download it from the Models tab first."}',
        )
      }
      return 'chunk-rendered-on-loaded'
    })
    assert.equal(result, 'chunk-rendered-on-loaded')
    // Whichever endpoint(s) the random tie-break tried, the chunk landed on
    // the loaded one. (Pre-v1.0.321 the test could rely on pick() being
    // deterministic and assert the exact liveCount; now random tie-break means
    // the loaded endpoint might be tried first, so 0–2 missing endpoints may
    // get marked down on any given run. The invariant that matters is just
    // that the chunk succeeds, which the result assertion above covers.)
    assert.ok(tried.includes('http://kokoro-loaded:47870'), 'eventually hit the endpoint with the model')
  })

  test('runOnPool fails over on "no models loaded" (LM Studio variant)', async () => {
    const d = createDispatcher(['http://a:1234', 'http://b:1234'])
    const result = await runOnPool(d, 'http://a:1234', async (ep) => {
      if (ep.includes('a')) throw new Error('No models loaded')
      return 'ok-from-b'
    })
    assert.equal(result, 'ok-from-b')
  })

  // v1.0.324 — the EP0003 "Failed to parse URL from http://a, http://b, …"
  // bug. Before this fix, runOnPool's `dispatcher.pick() ?? fallbackUrl`
  // silently used fallbackUrl once the pool was exhausted mid-job. The audio
  // and image callers pass the comma-joined apiKey there, so the WHOLE URL
  // LIST would get smeared into a single URL field and the underlying fetch
  // failed with a parse error rather than a clean "pool exhausted" throw.
  test('runOnPool NEVER passes the comma-list fallbackUrl to fn when the pool is exhausted', async () => {
    const d = createDispatcher(['http://a:47870', 'http://b:47870'])
    const COMMA_LIST = 'http://a:47870, http://b:47870, http://c:47870'
    const tried: string[] = []
    await assert.rejects(
      () => runOnPool(d, COMMA_LIST, async (ep) => {
        tried.push(ep)
        throw new Error("Voice Studio job failed: RuntimeError: mlx-audio didn't produce a wav file")
      }),
      // Throws the last real error, not a URL parse error from the comma-list.
      /didn't produce a wav file/,
    )
    // Critically: the callback was NEVER invoked with the comma-list.
    for (const t of tried) {
      assert.ok(!t.includes(','), `callback got "${t}" — comma-list smeared into endpoint slot`)
    }
    assert.equal(d.liveCount(), 0, 'all endpoints marked down after exhausting the pool')
  })

  test('runOnPool throws a clear error if the pool was empty before any attempt', async () => {
    const d = createDispatcher(['http://a:47870'])
    d.markDown('http://a:47870')          // pool empty before runOnPool runs
    await assert.rejects(
      () => runOnPool(d, 'http://anything', async () => 'never-called'),
      /All endpoints in the pool are unavailable/,
    )
  })

  test('runOnPool rethrows a TRUE content error immediately (no failover)', async () => {
    const d = createDispatcher(['http://a:1234', 'http://b:1234'])
    let calls = 0
    await assert.rejects(
      () => runOnPool(d, 'http://a:1234', async () => { calls++; throw new Error('400 Bad Request: prompt too long') }),
      /Bad Request/,
    )
    assert.equal(calls, 1, 'real content error should NOT fan out across the pool')
    assert.equal(d.liveCount(), 2, 'no endpoint marked down on a real content error')
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
    // v1.0.321 — when ALL endpoints are idle, the pick is randomised across
    // the candidates (was: always the first in the list, which let a single-
    // chunk retry job hit the same broken endpoint every time). Just assert
    // the pick is one of the live endpoints.
    const first = d.pick()
    assert.ok(['http://a:1234', 'http://b:1234', 'http://c:1234'].includes(first!))
    // The picked endpoint now has 1 in-flight; the next pick goes to one of
    // the other two (least-busy is strictly enforced once counts diverge).
    const second = d.pick()
    assert.notEqual(second, first, 'second pick goes to a different (still-idle) endpoint')
    d.markDown('http://a:1234')
    assert.equal(d.liveCount(), 2, 'marked-down endpoint is out of rotation')
  })

  test('markUp returns a recovered endpoint to rotation without waiting out the TTL (v1.0.341)', () => {
    const d = createDispatcher(['http://a:1234', 'http://b:1234', 'http://c:1234'])
    d.markDown('http://a:1234')
    assert.equal(d.liveCount(), 2, 'down endpoint excluded')
    d.markUp('http://a:1234')
    assert.equal(d.liveCount(), 3, 'markUp brought it straight back into rotation')
    // markUp on an endpoint that isn't part of the pool is a safe no-op
    d.markUp('http://not-in-pool:9999')
    assert.equal(d.liveCount(), 3)
    assert.equal(d.size, 3, 'markUp never adds new endpoints')
  })

  // v1.0.321 — regression guard for the EP0002 Chapter 04 case: 3 retries of
  // the same single-chunk job all landed on the same broken Mac because pick()
  // returned the first endpoint deterministically when the pool was idle.
  test('repeated single-pick on an idle pool spreads across endpoints (random tie-break)', () => {
    const urls = ['http://a:47870', 'http://b:47870', 'http://c:47870', 'http://d:47870', 'http://e:47870']
    const counts: Record<string, number> = {}
    for (let i = 0; i < 200; i++) {
      const d = createDispatcher(urls)         // fresh dispatcher each iteration
      const picked = d.pick()!                 // simulates a single-chunk job
      counts[picked] = (counts[picked] || 0) + 1
    }
    // Every endpoint must have been picked at least a few times across 200
    // fresh-dispatcher single-picks (was: ONLY the first endpoint, every time).
    for (const u of urls) {
      assert.ok(
        (counts[u] || 0) >= 10,
        `${u} should be picked sometimes (got ${counts[u] || 0}/200) — random tie-break broken`,
      )
    }
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
