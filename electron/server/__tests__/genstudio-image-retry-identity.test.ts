/**
 * Regression cover for the "manual Retry reused three terminal jobs from six
 * days ago" bug.
 *
 * Everything here runs against the in-process mock GenStudio service — zero
 * network, zero spend. The mock enforces the real idempotency contract (a
 * repeated Idempotency-Key replays the SAME job instead of creating another),
 * so "did this submit new paid work?" is answered by
 * `providerSubmissionCount('image')` rather than by inspection.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
} from './fixtures/mock-genstudio-service.js'
import { completionErrorMessage } from '../services/job-completion.js'
import { selectSceneImageBatch } from '../services/scene-image-batch-selection.js'
import { hashInput, type TaskManifestEntry } from '../services/task-manifest.js'
import type { ImageModelConfig } from '../models/types.js'

// services/app-settings.ts resolves its settings-file path ONCE at module load,
// so anything that transitively imports it must be loaded AFTER
// STORY_STUDIO_DATA_DIR points at this test's own directory. Importing
// lib/manifest-recovery.js (→ lib/genstudio-client.ts → services/app-settings.ts)
// at the top of the file instead bound the REAL user app-settings.json, so the
// `setGenStudioUrl` calls below rewrote the developer's live settings — and,
// during a parallel test run, changed the GenStudio base URL out from under
// other test processes mid-assertion.
const temp = await useTempDataDir()
const {
  resolveManualImageReplacement,
  hasPipelineRepairImageAttempt,
  isTerminalGenStudioImageTaskFailure,
  resolveImageRetryScope,
  terminalImageManifestEntry,
  tryRecoverImageFromManifestEntry,
} = await import('../lib/manifest-recovery.js')

const MODEL_CONFIG = { provider: 'genstudio-image' } as ImageModelConfig

function manifestEntry(overrides: Partial<TaskManifestEntry> = {}): TaskManifestEntry {
  return {
    provider: 'genstudio',
    task_id: 'mock-image-001',
    submitted_at: '2026-07-24T00:00:00.000Z',
    operation: 'image',
    ...overrides,
  }
}

void test('Gateway image retry identity is fresh after failure and stable on a lost response', async (suite) => {
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  try {
    const settings = await import('../services/app-settings.js')
    await settings.setGenStudioUrl(service.baseUrl)
    const client = await import('../lib/genstudio-client.js')

    const submit = (requestIdentity: string, prompt = 'A calm moonlit temple above a river.') =>
      client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        prompt,
        modelId: 'mock-image-v1',
        aspectRatio: '16:9',
        requestIdentity,
      })

    await suite.test('a SUCCEEDED saved job hands back its artifact without resubmitting', async () => {
      service.reset()
      const first = await submit('scene:a')
      assert.equal(service.providerSubmissionCount('image'), 1)

      const outcome = await tryRecoverImageFromManifestEntry(
        manifestEntry({ task_id: first.jobId, last_state: 'accepted' }),
        MOCK_GENSTUDIO_FULL_KEY,
        MODEL_CONFIG,
      )

      assert.equal(outcome.kind, 'recovered')
      assert.equal(outcome.kind === 'recovered' && outcome.taskId, first.jobId)
      assert.ok(outcome.kind === 'recovered' && outcome.urls[0]!.startsWith('data:image/png;base64,'))
      // The whole point: reclaiming a settled success never costs a second job.
      assert.equal(service.providerSubmissionCount('image'), 1)
    })

    await suite.test('an ACTIVE saved job is reported as still generating, not resubmitted', async () => {
      service.reset()
      // Accepted → dispatched → running → succeeded: still in flight when the
      // manifest entry was written, so recovery must poll it to completion.
      service.queueScenario('image', { states: ['accepted', 'dispatched', 'running', 'succeeded'] })
      const started = await submit('scene:active')
      assert.equal(service.providerSubmissionCount('image'), 1)
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith(`/v1/images/${started.jobId}`)) {
          return Response.json({ id: started.jobId, state: 'running', cancelled: false })
        }
        return originalFetch(input, init)
      }
      let outcome
      try {
        outcome = await tryRecoverImageFromManifestEntry(
          manifestEntry({ task_id: started.jobId, last_state: 'accepted' }),
          MOCK_GENSTUDIO_FULL_KEY,
          MODEL_CONFIG,
          undefined,
          { observeCurrentState: true },
        )
      } finally {
        globalThis.fetch = originalFetch
      }

      assert.equal(outcome.kind, 'still-generating')
      assert.match(outcome.kind === 'still-generating' ? outcome.state : '', /accepted|dispatched|running/)
      assert.equal(service.providerSubmissionCount('image'), 1)
    })

    await suite.test('a TERMINAL FAILED saved job is never reopened and yields exactly one fresh job', async () => {
      service.reset()
      service.queueScenario('image', { states: ['failed'], failureCode: 'provider_error' })
      const baseScope = 'missing'
      const prompt = 'A calm moonlit temple above a river.'

      await assert.rejects(
        submit(`scene:retry:${baseScope}`, prompt),
        (error: unknown) => error instanceof client.GenStudioImageTerminalFailureError,
        'a terminal image failure must surface as a typed error, not a message string',
      )
      const deadJobId = service.submissions[0]!.jobId
      assert.equal(service.providerSubmissionCount('image'), 1)

      // What the generator persists once it observes the terminal outcome.
      const failed = manifestEntry({
        task_id: deadJobId,
        request_scope: baseScope,
        input_hash: hashInput(`${baseScope}\n${prompt}`),
        last_state: 'failed',
      })
      assert.ok(isTerminalGenStudioImageTaskFailure(failed))

      // Recovery refuses to reopen it — and does so without a network round trip.
      const requestsBefore = service.requests.length
      const outcome = await tryRecoverImageFromManifestEntry(
        failed, MOCK_GENSTUDIO_FULL_KEY, MODEL_CONFIG,
      )
      assert.equal(outcome.kind, 'terminal-failed')
      assert.equal(service.requests.length, requestsBefore)

      // The manual Retry mints a NEW identity, so GenStudio sees genuinely new work.
      const retry = resolveImageRetryScope(failed, baseScope)
      assert.ok(retry.isRetry)
      assert.notEqual(retry.scope, baseScope)
      assert.equal(retry.previousTaskId, deadJobId)

      const fresh = await submit(`scene:retry:${retry.scope}`, prompt)
      assert.equal(service.providerSubmissionCount('image'), 2, 'exactly one fresh job')
      assert.notEqual(fresh.jobId, deadJobId)

      // Retrying the same terminal entry again resolves to the SAME scope, so a
      // repeated attempt replays rather than paying a third time.
      assert.equal(resolveImageRetryScope(failed, baseScope).scope, retry.scope)
      const replay = await submit(`scene:retry:${retry.scope}`, prompt)
      assert.equal(replay.jobId, fresh.jobId)
      assert.equal(service.providerSubmissionCount('image'), 2)
    })

    await suite.test('a lost submit response re-attaches instead of duplicating a paid submission', async () => {
      service.reset()
      // The mock destroys the socket on the first POST: the job exists and is
      // reserved upstream, but Story Studio never saw the response.
      service.queueScenario('image', { states: ['succeeded'], dropFirstSubmitResponse: true })
      const identity = 'scene:lost-response'

      // The submit is retried under the SAME idempotency key, so the lost
      // response re-attaches to the job that already exists upstream.
      const first = await submit(identity)
      assert.equal(service.providerSubmissionCount('image'), 1, 'the dropped response created exactly one job')
      assert.ok(service.replayCount(first.jobId) >= 1, 'the retry replayed rather than created')

      // And a later attempt that rebuilds the same identity still re-attaches.
      const again = await submit(identity)
      assert.equal(again.jobId, first.jobId)
      assert.equal(service.providerSubmissionCount('image'), 1, 'no second paid job')
    })

    await suite.test('a prepared entry with no task id reclaims by its durable idempotency key', async () => {
      service.reset()
      const requestIdentity = 'scene:prepared-response-lost'
      const result = await submit(requestIdentity)
      const key = client.buildGenStudioImageIdempotencyKey({
        prompt: 'A calm moonlit temple above a river.',
        modelId: 'mock-image-v1',
        aspectRatio: '16:9',
        requestIdentity,
      })

      const outcome = await tryRecoverImageFromManifestEntry(
        manifestEntry({ task_id: '', idempotency_key: key, last_state: 'prepared' }),
        MOCK_GENSTUDIO_FULL_KEY,
        MODEL_CONFIG,
      )

      assert.equal(outcome.kind, 'recovered')
      assert.equal(outcome.kind === 'recovered' && outcome.taskId, result.jobId)
      assert.equal(service.providerSubmissionCount('image'), 1)
    })

    await suite.test('a HELD failed job is not terminal: the Gateway may still adopt its answer', async () => {
      service.reset()
      const requestIdentity = 'scene:held-unknown-outcome'
      const prompt = 'A calm moonlit temple above a river.'
      service.queueScenario('image', { states: ['failed'], failureCode: 'provider_error' })
      await assert.rejects(
        submit(requestIdentity, prompt),
        (error: unknown) => error instanceof client.GenStudioImageTerminalFailureError,
      )
      const heldJobId = service.submissions[0]!.jobId
      const key = client.buildGenStudioImageIdempotencyKey({
        prompt, modelId: 'mock-image-v1', aspectRatio: '16:9', requestIdentity,
      })

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        if (String(input).includes('/v1/images/by-idempotency-key/')) {
          // The Gateway is still holding this failed job as an unknown outcome
          // (`origin-field/38cf1226`, `sleep-stories/516bd788`): the answer may
          // yet be adopted, so `state: failed` here is not a settled failure.
          return Response.json({
            id: heldJobId, state: 'failed', cancelled: false, failure_code: 'provider_error',
            recovery_required: true, recovery_state: 'unknown_outcome',
          })
        }
        return originalFetch(input, init)
      }
      let outcome
      try {
        outcome = await tryRecoverImageFromManifestEntry(
          manifestEntry({ task_id: '', idempotency_key: key, last_state: 'prepared' }),
          MOCK_GENSTUDIO_FULL_KEY,
          MODEL_CONFIG,
        )
      } finally {
        globalThis.fetch = originalFetch
      }

      assert.equal(outcome.kind, 'uncertain',
        'a held failure is not settled, so recovery must not mint a fresh request identity for it')
      assert.equal(service.providerSubmissionCount('image'), 1)
    })

    await suite.test('a prepared key with no authoritative job is safe to replay under its same key', async () => {
      service.reset()
      const outcome = await tryRecoverImageFromManifestEntry(
        manifestEntry({ task_id: '', idempotency_key: 'story-image-missing-key', last_state: 'prepared' }),
        MOCK_GENSTUDIO_FULL_KEY,
        MODEL_CONFIG,
        undefined,
        { allowPreparedReplayOnAbsent: true },
      )
      assert.equal(outcome.kind, 'no-saved-job')
      assert.equal(service.providerSubmissionCount('image'), 0)
    })

    await suite.test('a prepared key owned by the same Pipeline repair may replay the exact absent submission', async () => {
      service.reset()
      const outcome = await tryRecoverImageFromManifestEntry(
        manifestEntry({
          task_id: '', idempotency_key: 'story-image-pipeline-prepared', last_state: 'prepared',
          request_scope: 'manual-finish:8e747b4d-730c-4b28-96b8-758256e9ea57',
        }),
        MOCK_GENSTUDIO_FULL_KEY,
        MODEL_CONFIG,
        undefined,
        { allowPreparedReplayOnAbsent: true },
      )
      assert.equal(outcome.kind, 'no-saved-job', '404 proves this exact prepared key never reached the Gateway')
      assert.equal(service.providerSubmissionCount('image'), 0, 'the recovery check itself remains read-only')
    })

    await suite.test('an unconfirmed reconnect is reported as uncertain, never as "nothing was submitted"', async () => {
      service.reset()
      const settingsModule = await import('../services/app-settings.js')
      await settingsModule.setGenStudioUrl('http://127.0.0.1:1')
      try {
        const outcome = await tryRecoverImageFromManifestEntry(
          manifestEntry({ task_id: 'mock-image-999', last_state: 'accepted' }),
          MOCK_GENSTUDIO_FULL_KEY,
          MODEL_CONFIG,
        )
        assert.equal(outcome.kind, 'uncertain')
        assert.equal(outcome.kind === 'uncertain' && outcome.taskId, 'mock-image-999')
      } finally {
        await settingsModule.setGenStudioUrl(service.baseUrl)
      }
    })

    await suite.test('lenient: a free-fleet key the Gateway has no job for counts as not made and gets a fresh identity', async () => {
      service.reset()
      const entry = manifestEntry({
        task_id: '', idempotency_key: 'story-image-no-such-job', last_state: 'accepted', request_scope: 'action-1',
      })
      const paid = await tryRecoverImageFromManifestEntry(entry, MOCK_GENSTUDIO_FULL_KEY, MODEL_CONFIG)
      assert.equal(paid.kind, 'uncertain', 'paid images keep the careful path')
      const free = await tryRecoverImageFromManifestEntry(
        entry, MOCK_GENSTUDIO_FULL_KEY, { ...MODEL_CONFIG, api_model: 'studio-hub::mock-image-v1' },
      )
      assert.equal(free.kind, 'terminal-failed')
      if (free.kind !== 'terminal-failed') return
      const retry = resolveImageRetryScope(terminalImageManifestEntry(entry, free), 'action-1')
      assert.equal(retry.isRetry, true)
      assert.notEqual(retry.scope, 'action-1')
      assert.equal(service.providerSubmissionCount('image'), 0, 'the check itself submits nothing')
    })

    await suite.test('a retry submits only the scenes still missing on disk', async () => {
      service.reset()
      const scenes = [
        { id: 'scene-1', scene_index: 1, visual_prompt: 'A temple gate at dawn.' },
        { id: 'scene-2', scene_index: 2, visual_prompt: 'A river under moonlight.' },
        { id: 'scene-3', scene_index: 3, visual_prompt: 'A quiet courtyard.' },
      ]
      const rendered = new Set(['scene-1', 'scene-3'])
      const toRender = selectSceneImageBatch(scenes, {
        sceneIds: ['scene-1', 'scene-2', 'scene-3'],
        missingOnly: true,
        singleIndex: 0,
        force: false,
        hasRenderedImage: (id: string) => rendered.has(id),
      })

      assert.deepEqual(toRender.map(scene => scene.id), ['scene-2'])
      for (const scene of toRender) await submit(`scene:${scene.id}:missing`)
      assert.equal(service.providerSubmissionCount('image'), 1, 'completed scenes are never resubmitted')
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

void test('a settled saved job is promoted to a terminal manifest entry', () => {
  const entry = manifestEntry({ task_id: 'mock-image-007', request_scope: 'missing' })

  const failed = terminalImageManifestEntry(entry, {
    kind: 'terminal-failed', taskId: 'mock-image-007', failureCode: 'provider_error', reason: 'failed',
  })
  assert.equal(failed.last_state, 'failed')
  assert.equal(failed.operation, 'image')
  assert.ok(isTerminalGenStudioImageTaskFailure(failed))

  const expired = terminalImageManifestEntry(entry, {
    kind: 'artifact-unavailable', taskId: 'mock-image-007', reason: 'gone',
  })
  assert.equal(expired.last_state, 'artifact_expired')
  assert.ok(isTerminalGenStudioImageTaskFailure(expired))

  // An accepted, still-running job stays reclaimable.
  assert.equal(isTerminalGenStudioImageTaskFailure(manifestEntry({ last_state: 'accepted' })), false)
  assert.equal(isTerminalGenStudioImageTaskFailure(null), false)
})

void test('retry scopes are deterministic, bounded, and scoped to their base attempt', () => {
  const failed = manifestEntry({ task_id: 'job-a', request_scope: 'missing', last_state: 'failed' })
  const first = resolveImageRetryScope(failed, 'missing')

  // Deterministic: no clock, no randomness — the same inputs give the same scope.
  assert.equal(resolveImageRetryScope(failed, 'missing').scope, first.scope)
  assert.match(first.scope, /^missing:retry:[0-9a-f]{12}$/)

  // A second terminal failure chains without unbounded growth.
  const failedAgain = manifestEntry({ task_id: 'job-b', request_scope: first.scope, last_state: 'failed' })
  const second = resolveImageRetryScope(failedAgain, 'missing')
  assert.notEqual(second.scope, first.scope)
  assert.match(second.scope, /^missing:retry:2:[0-9a-f]{12}$/)
  assert.equal(resolveImageRetryScope(failedAgain, 'missing').scope, second.scope)
  const third = resolveImageRetryScope(manifestEntry({ task_id: 'job-c', request_scope: second.scope, last_state: 'failed' }), 'missing')
  assert.match(third.scope, /^missing:retry:3:[0-9a-f]{12}$/)
  assert.equal(third.scope.length, second.scope.length)
  assert.match(resolveImageRetryScope(failedAgain, 'missing', 5).scope, /^missing:retry:5:[0-9a-f]{12}$/)

  // A prepared (not yet settled) entry keeps its scope so a lost response replays.
  const prepared = manifestEntry({ task_id: '', request_scope: second.scope, last_state: 'prepared' })
  assert.equal(resolveImageRetryScope(prepared, 'missing').scope, second.scope)

  // A different deliberate attempt never inherits another attempt's retry chain.
  assert.equal(resolveImageRetryScope(failedAgain, 'force:job-77').scope, 'force:job-77')
})

void test('Replace anyway keeps the complete uncertain identity and replays one action scope', () => {
  const uncertain = manifestEntry({
    task_id: '',
    idempotency_key: 'story-image-old-key',
    request_scope: 'missing:retry:old',
    input_hash: 'sha256:old',
    last_state: 'prepared',
  })
  const first = resolveManualImageReplacement(uncertain, '8e747b4d-730c-4b28-96b8-758256e9ea57')
  const replay = resolveManualImageReplacement(uncertain, '8e747b4d-730c-4b28-96b8-758256e9ea57')

  assert.deepEqual(replay, first)
  assert.match(first.scope, /^manual-finish:8e747b4d-730c-4b28-96b8-758256e9ea57:replace:[0-9a-f]{12}$/)
  assert.deepEqual(first.superseded, {
    provider: 'genstudio',
    task_id: '',
    submitted_at: '2026-07-24T00:00:00.000Z',
    idempotency_key: 'story-image-old-key',
    input_hash: 'sha256:old',
    request_scope: 'missing:retry:old',
    operation: 'image',
    last_state: 'prepared',
  })
})

void test('one Pipeline repair action cannot mint a second fresh image request after restart', () => {
  const actionId = '8e747b4d-730c-4b28-96b8-758256e9ea57'
  assert.equal(hasPipelineRepairImageAttempt(manifestEntry({ request_scope: `manual-finish:${actionId}` }), actionId), true)
  assert.equal(hasPipelineRepairImageAttempt(manifestEntry({ request_scope: `manual-finish:${actionId}:replace:abc123` }), actionId), true)
  assert.equal(hasPipelineRepairImageAttempt(manifestEntry({ request_scope: `manual-finish:${actionId}:selector:abc:references:def` }), actionId), true)
  assert.equal(hasPipelineRepairImageAttempt(manifestEntry({
    request_scope: 'manual-finish:later-action',
    superseded_image_requests: [{ provider: 'genstudio', task_id: 'old', submitted_at: '2026-07-24T00:00:00.000Z', request_scope: `manual-finish:${actionId}` }],
  }), actionId), true)
  assert.equal(hasPipelineRepairImageAttempt(manifestEntry({ request_scope: 'manual-finish:different-action' }), actionId), false)
  assert.equal(hasPipelineRepairImageAttempt(manifestEntry({ request_scope: 'missing:retry:abc123' }), actionId), false)
})

void test('completion errors name each unresolved item exactly once', () => {
  const message = completionErrorMessage({
    label: 'Scene image generation',
    expected: 3,
    completed: 1,
    missing: ['scene-2', 'scene-3'],
    invalid: ['scene-2', 'scene-3', 'scene-4'],
  })

  assert.equal((message.match(/scene-2/g) || []).length, 1)
  assert.equal((message.match(/scene-3/g) || []).length, 1)
  assert.match(message, /scene-4/)
  assert.match(message, /Missing\/invalid: scene-2, scene-3, scene-4\./)
})
