/**
 * Images get the same "one exhausted route is retryable, everything else is
 * not" treatment `audio-route-exhausted-retry.test.ts` pins for speech —
 * plus the two gaps that were specific to a 333-scene image batch:
 *
 *  - `job.item_progress` / `job.progress` did not exist for images at all, so
 *    a long batch looked identical to a hang.
 *  - A single failed scene out of 333 threw a message naming only the first
 *    three, and the completion audit (`requireJobCompletion`, which names
 *    every missing item) was never reached — the throw happened before it.
 *
 * Everything here runs against the in-process mock GenStudio service — zero
 * network, zero spend — or directly against `job-completion.ts`, exactly the
 * way `completion-contract.test.ts` already pins that contract for other
 * generators.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
} from './fixtures/mock-genstudio-service.js'
import {
  GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
  GenStudioImageTerminalFailureError,
  isGenStudioRouteExhausted,
} from '../lib/genstudio-client.js'
import { resolveImageRetryScope } from '../lib/manifest-recovery.js'
import { hashInput } from '../services/task-manifest.js'
import { completionErrorMessage, requireJobCompletion } from '../services/job-completion.js'
import {
  IMAGE_ROUTE_RETRY_BASE_MS,
  IMAGE_ROUTE_RETRY_BASE_MS_ENV,
  IMAGE_ROUTE_RETRY_MAX_ATTEMPTS,
  IMAGE_ROUTE_RETRY_MAX_DELAY_MS,
  imageRouteRetryDelayMs,
} from '../services/image-route-retry.js'
import type { Job } from '../models/types.js'

function job(): Job {
  return {
    job_id: 'image-batch-01', project_slug: 'test', type: 'thumb_images', episode_id: 'EP0067', title: '',
    status: 'running', created_at: '', started_at: '', finished_at: null, error: null,
    output_lines: [], params: {},
  }
}

test('an image route-exhaustion classifies the same way TTS does, including cancellation', () => {
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioImageTerminalFailureError({
      id: 'img-exhausted', state: 'failed', failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
      reserved_credits: 9, settled_credits: 0, released_credits: 9,
    })),
    true,
  )
  // A provider took the work and it failed. Retrying pays for it twice.
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioImageTerminalFailureError({
      id: 'img-failed', state: 'failed', failure_code: 'CLOUD_PROVIDER_FAILED',
    })),
    false,
  )
  // GenStudio could not tell whether a provider had already accepted it —
  // never resubmitted by machine.
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioImageTerminalFailureError({
      id: 'img-uncertain', state: 'failed', failure_code: 'CLOUD_SUBMISSION_UNCERTAIN',
    })),
    false,
  )
  // The user asked for it to stop, however GenStudio settled it.
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioImageTerminalFailureError({
      id: 'img-cancelled', state: 'failed', failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE, cancelled: true,
    })),
    false,
  )
})

test('settlement never decides route exhaustion — the code and cancellation do', () => {
  // Story no longer tracks credits: the error's credit fields are null, so a
  // legacy payload's settled/released numbers can neither grant nor deny the
  // classification. Only the failure code and the owner's cancellation decide.
  const base = { id: 'img-exhausted', state: 'failed', failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE }
  const cases = [
    {}, // no settlement fields at all
    { reserved_credits: 9 }, // reservation kept, never settled
    { reserved_credits: 9, settled_credits: 1, released_credits: 8 }, // charged legacy shape
    { reserved_credits: 9, settled_credits: 0, released_credits: 8 }, // partial release
    { reserved_credits: 9, settled_credits: 0, released_credits: 9 }, // fully returned
  ] as const
  for (const over of cases) {
    const error = new GenStudioImageTerminalFailureError({ ...base, ...over })
    assert.equal(error.settledCredits, null, 'the error publishes no settlement to decide on')
    assert.equal(isGenStudioRouteExhausted(error), true, JSON.stringify(over))
  }
  // ...and the two that DO decide stay right here: cancellation, and a code
  // that is not route exhaustion.
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioImageTerminalFailureError({ ...base, cancelled: true })),
    false,
    "the owner's instruction stands",
  )
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioImageTerminalFailureError(
      { ...base, failure_code: 'CLOUD_PROVIDER_FAILED' })),
    false,
    'a provider fault is not route exhaustion',
  )
})

test('the image retry schedule is independently tunable from the TTS one', () => {
  const env: NodeJS.ProcessEnv = {}
  assert.equal(IMAGE_ROUTE_RETRY_MAX_ATTEMPTS, 4)

  const mid = () => 0.5
  assert.equal(imageRouteRetryDelayMs(0, env, mid), IMAGE_ROUTE_RETRY_BASE_MS)
  assert.equal(imageRouteRetryDelayMs(1, env, mid), IMAGE_ROUTE_RETRY_BASE_MS * 2)
  assert.equal(imageRouteRetryDelayMs(5, env, mid), IMAGE_ROUTE_RETRY_MAX_DELAY_MS)

  for (const random of [() => 0, () => 1, () => 0.5, () => 0.13]) {
    for (let attempt = 0; attempt < IMAGE_ROUTE_RETRY_MAX_ATTEMPTS; attempt++) {
      const delay = imageRouteRetryDelayMs(attempt, env, random)
      assert.ok(delay >= 0, `attempt ${attempt} produced ${delay}`)
      assert.ok(delay <= IMAGE_ROUTE_RETRY_MAX_DELAY_MS * 1.2, `attempt ${attempt} produced ${delay}`)
    }
  }
  // Many scenes of one batch fail against the same exhausted window; an
  // unjittered schedule would send them all back at the same instant.
  assert.notEqual(imageRouteRetryDelayMs(0, env, () => 0), imageRouteRetryDelayMs(0, env, () => 1))

  // Its own env var — tuning TTS pacing must not silently move images.
  assert.equal(IMAGE_ROUTE_RETRY_BASE_MS_ENV, 'STORY_STUDIO_IMAGE_RETRY_BASE_MS')
  assert.equal(imageRouteRetryDelayMs(0, { [IMAGE_ROUTE_RETRY_BASE_MS_ENV]: '10' }, mid), 10)
  assert.equal(imageRouteRetryDelayMs(0, { [IMAGE_ROUTE_RETRY_BASE_MS_ENV]: 'soon' }, mid), IMAGE_ROUTE_RETRY_BASE_MS)

  // No clock, no counter, no randomness baked into the module itself — only
  // the injected `random` parameter may vary a delay.
  const source = readFileSync(new URL('../services/image-route-retry.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /Date\.now|randomUUID/)
})

void test('an exhausted image route retries into exactly one new job via the existing retry-scope chain', async (suite) => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  let previousGenStudioUrl = ''

  try {
    const settings = await import('../services/app-settings.js')
    previousGenStudioUrl = await settings.getGenStudioUrl()
    await settings.setGenStudioUrl(service.baseUrl)
    const client = await import('../lib/genstudio-client.js')

    const baseScope = 'default'
    const prompt = 'A lantern-lit temple courtyard at dusk.'
    const submit = (scope: string) => client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      prompt,
      modelId: 'mock-image-v1',
      aspectRatio: '16:9',
      requestIdentity: `demo:EP0067:scene:12:image:${scope}`,
    })

    let exhaustedJobId = ''

    await suite.test('the first attempt settles failed with nothing charged', async () => {
      service.queueScenario('image', {
        states: ['accepted', 'failed'],
        failureCode: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
      })
      const error = await submit(baseScope).then(() => null, (e: unknown) => e)
      assert.ok(error instanceof GenStudioImageTerminalFailureError)
      assert.equal(error.failureCode, GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE)
      assert.equal(isGenStudioRouteExhausted(error), true)
      assert.equal(service.providerSubmissionCount('image'), 1)
      exhaustedJobId = error.jobId
      assert.ok(exhaustedJobId)
      const credits = service.creditSnapshot(exhaustedJobId)
      assert.equal(credits.final, 0)
      assert.equal(credits.returned, credits.reserved)
    })

    await suite.test('the promoted scope submits one new job and saves the image', async () => {
      // This is exactly what `deriveRouteRetryAttempt` in generators/images.ts
      // does after catching the exhaustion: build the failed entry from what
      // was just persisted, and promote it through the SAME
      // `resolveImageRetryScope` a cross-run manual Retry already uses.
      const failedEntry = {
        provider: 'genstudio', task_id: exhaustedJobId, submitted_at: new Date().toISOString(),
        input_hash: hashInput(`${baseScope}\n${prompt}`), request_scope: baseScope,
        operation: 'image' as const, last_state: 'failed',
      }
      const promoted = resolveImageRetryScope(failedEntry, baseScope)
      assert.ok(promoted.isRetry)
      assert.notEqual(promoted.scope, baseScope)

      await submit(promoted.scope)
      assert.equal(service.providerSubmissionCount('image'), 2, 'exactly one new job for the retry')

      // Replaying the SAME promoted scope re-attaches instead of buying a
      // third job — a retry that gets replayed after a crash or a restart
      // must not double-submit.
      await submit(promoted.scope)
      assert.equal(service.providerSubmissionCount('image'), 2, 'a replayed retry buys nothing')
    })

    await suite.test('the dead original identity still resolves to its dead job', async () => {
      const error = await submit(baseScope).then(() => null, (e: unknown) => e)
      assert.ok(error instanceof GenStudioImageTerminalFailureError)
      assert.equal(error.jobId, exhaustedJobId)
      assert.equal(service.providerSubmissionCount('image'), 2)
    })
  } finally {
    const settings = await import('../services/app-settings.js')
    if (previousGenStudioUrl) await settings.setGenStudioUrl(previousGenStudioUrl).catch(() => {})
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})

test('a partial image batch failure yields a usable result naming the failed scenes, not a 3-item preview', () => {
  const target = job()
  const failedScenes = ['Scene 12', 'Scene 45', 'Scene 201']

  assert.throws(
    () => requireJobCompletion(target, {
      label: 'Scene image generation',
      expected: 333,
      completed: 333 - failedScenes.length,
      missing: failedScenes,
      retry_hint: 'Existing images were kept. Retry generates or recovers only the missing files.',
    }),
    /330\/333.*Scene 12.*Scene 45.*Scene 201/s,
  )
  // The full count and every named scene survive — not truncated to 3 of N
  // like the message the old early-throw in images.ts used to produce.
  assert.equal(target.result?.complete, false)
  assert.equal(target.result?.completion?.completed, 330)
  assert.equal(target.result?.completion?.expected, 333)
  assert.deepEqual(target.result?.completion?.missing, failedScenes)
  assert.match(target.output_lines.at(-1) || '', /INCOMPLETE/)

  // completionErrorMessage itself, pinned directly against images.ts's exact
  // label/shape, the way completion-contract.test.ts already pins it for the
  // generic case.
  assert.match(
    completionErrorMessage({
      label: 'Scene image generation', expected: 333, completed: 330, missing: failedScenes,
      retry_hint: 'Retry generates or recovers only the missing files.',
    }),
    /Scene image generation incomplete: 330\/333 required item\(s\) verified\. Missing\/invalid: Scene 12, Scene 45, Scene 201\. Retry generates or recovers only the missing files\./,
  )
})

test('images.ts reuses the retry-scope chain and progress machinery instead of inventing new ones', () => {
  const source = readFileSync(new URL('../generators/images.ts', import.meta.url), 'utf8')

  // Classified with the shared helper, not a local reimplementation.
  assert.match(source, /isGenStudioRouteExhausted\(e\)/)
  assert.match(source, /attemptNum < IMAGE_ROUTE_RETRY_MAX_ATTEMPTS/)

  // Retry identity is the EXISTING image retry-scope chain
  // (`resolveImageRetryScope`, already exercised by
  // genstudio-image-retry-identity.test.ts for the manual/cross-run case),
  // not a forked `nextImageRouteRetryIdentity`.
  // Explicit force actions keep their caller-owned scope; every other retry
  // goes through the same resolver. The route-exhaustion path must call that
  // shared policy instead of growing a second local scope derivation.
  assert.match(source, /const actionScope = \(entry: TaskManifestEntry \| null \| undefined, baseScope: string\): string => \(\s*generationActionId\s*\? resolveImageRetryActionScope\(entry, baseScope\)\s*: resolveImageRetryScope\(entry, baseScope\)\.scope\s*\)/)
  assert.match(source, /const logicalScope = explicitScope \|\| actionScope\(failedEntry, previous\.baseScope\)/)
  assert.doesNotMatch(source, /nextImageRouteRetryIdentity/)

  // Live per-item state, published on every transition including the wait.
  assert.match(source, /job\.item_progress = \{/)
  assert.match(source, /state: 'waiting_retry'/)
  assert.match(source, /job\.progress = totalToProcess > 0/)

  // Progress is driven by settled counts, never by cursor/index position —
  // the thing that would make it jump around under concurrency.
  assert.match(source, /completedCount \+ failedCount/)

  // The fan-out width is local staging only. The keyed live burst is advisory;
  // GenStudio's exact admission permit owns remote image placement.
  assert.match(source, /const maxWorkers = resolveGenStudioLocalFanout\(\s*\n?\s*items\.length,\s*\n?\s*admission\.burst_concurrency_ceiling,/)
  assert.match(source, /refreshGenStudioAdmission\(/)

  // The old early-throw that bypassed the completion audit and only showed
  // the first 3 failures is gone.
  assert.doesNotMatch(source, /errors\.slice\(0, 3\)/)
  assert.doesNotMatch(source, /\$\{errors\.length\} item\(s\) failed/)
  // The completion audit always runs now, not only when `errors` is empty.
  assert.match(source, /requireJobCompletion\(job, \{/)
})
