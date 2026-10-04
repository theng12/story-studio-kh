/**
 * Speech is retried automatically when — and only when — no provider route
 * ever took the work.
 *
 * The live failure this pins: ten sections dispatched at once, six settled
 * `failed` with `CLOUD_PROVIDER_EXHAUSTED`, every one of them fine on a later
 * solo attempt. That code is emitted after GenStudio has walked its whole
 * ranked route list and had each one decline the submission, so it proves
 * nothing was accepted, nothing was executed, and the reservation was
 * released. Asking again therefore costs time and nothing else.
 *
 * Everything here runs against the in-process mock GenStudio service — zero
 * network, zero spend. The mock enforces the real idempotency contract (a
 * repeated Idempotency-Key replays the SAME job rather than creating another),
 * so "did the retry buy a second job?" is answered by
 * `providerSubmissionCount('tts')` rather than by reading the code.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
} from './fixtures/mock-genstudio-service.js'
import {
  GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
  GenStudioApiError,
  GenStudioTtsArtifactUnavailableError,
  GenStudioTtsTerminalFailureError,
  isGenStudioRouteExhausted,
} from '../lib/genstudio-client.js'
import {
  nextTtsRouteRetryIdentity,
  TTS_ROUTE_RETRY_BASE_MS,
  TTS_ROUTE_RETRY_BASE_MS_ENV,
  TTS_ROUTE_RETRY_MAX_ATTEMPTS,
  TTS_ROUTE_RETRY_MAX_DELAY_MS,
  ttsRouteRetryDelayMs,
} from '../services/tts-capacity-retry.js'

test('only an exhausted route is retryable; every other settled outcome is not', () => {
  assert.equal(GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE, 'CLOUD_PROVIDER_EXHAUSTED')

  assert.equal(
    isGenStudioRouteExhausted(new GenStudioTtsTerminalFailureError({
      id: 'tts-exhausted', state: 'failed', failure_code: 'CLOUD_PROVIDER_EXHAUSTED',
      reserved_credits: 1, settled_credits: 0, released_credits: 1,
    })),
    true,
  )

  // A provider took the work and it failed. Retrying pays for it twice.
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioTtsTerminalFailureError({
      id: 'tts-failed', state: 'failed', failure_code: 'CLOUD_PROVIDER_FAILED',
    })),
    false,
  )
  // GenStudio could not tell whether a provider had already accepted it. This
  // is the one failure that must NEVER be resubmitted by machine.
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioTtsTerminalFailureError({
      id: 'tts-uncertain', state: 'failed', failure_code: 'CLOUD_SUBMISSION_UNCERTAIN',
    })),
    false,
  )
  // A body GenStudio would not accept, and a route list that was empty before
  // anything was tried. Neither improves by being sent again.
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioTtsTerminalFailureError({
      id: 'tts-bad-submit', state: 'failed', failure_code: 'CLOUD_PROVIDER_SUBMISSION_FAILED',
    })),
    false,
  )
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioTtsTerminalFailureError({
      id: 'tts-no-routes', state: 'failed', failure_code: 'CLOUD_PROVIDER_UNAVAILABLE',
    })),
    false,
  )
  // The user asked for it to stop, however GenStudio settled it.
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioTtsTerminalFailureError({
      id: 'tts-cancelled',
      state: 'failed',
      failure_code: 'CLOUD_PROVIDER_EXHAUSTED',
      cancelled: true,
    })),
    false,
  )
  // A code this build has never seen is treated as work a provider may have
  // done — the safe way to be wrong.
  assert.equal(
    isGenStudioRouteExhausted(new GenStudioTtsTerminalFailureError({
      id: 'tts-new-code', state: 'failed', failure_code: 'SOME_FUTURE_CODE',
    })),
    false,
  )
  // Not a settled job at all. An out-of-credit 402 and a refused key fail fast
  // here exactly as they did before.
  assert.equal(isGenStudioRouteExhausted(new GenStudioApiError(402, 'insufficient credits')), false)
  assert.equal(isGenStudioRouteExhausted(new GenStudioApiError(429, 'rate limited')), false)
  assert.equal(isGenStudioRouteExhausted(new GenStudioTtsArtifactUnavailableError('tts-gone', 404)), false)
  assert.equal(isGenStudioRouteExhausted(new Error('the provider is exhausted')), false)
  assert.equal(isGenStudioRouteExhausted(null), false)
})

test('the retry schedule spaces attempts and jitters them apart', () => {
  const env: NodeJS.ProcessEnv = {}
  // Bounded: an exhausted route can also mean a provider account that will
  // never accept anything again, and a run must not hold an episode open
  // against that forever.
  assert.equal(TTS_ROUTE_RETRY_MAX_ATTEMPTS, 4)

  // Centre of each wait doubles, then flattens at the ceiling.
  const mid = () => 0.5
  assert.equal(ttsRouteRetryDelayMs(0, env, mid), TTS_ROUTE_RETRY_BASE_MS)
  assert.equal(ttsRouteRetryDelayMs(1, env, mid), TTS_ROUTE_RETRY_BASE_MS * 2)
  assert.equal(ttsRouteRetryDelayMs(5, env, mid), TTS_ROUTE_RETRY_MAX_DELAY_MS)

  // Jitter stays inside ±20% and never produces a negative wait.
  for (const random of [() => 0, () => 1, () => 0.5, () => 0.13]) {
    for (let attempt = 0; attempt < TTS_ROUTE_RETRY_MAX_ATTEMPTS; attempt++) {
      const delay = ttsRouteRetryDelayMs(attempt, env, random)
      assert.ok(delay >= 0, `attempt ${attempt} produced ${delay}`)
      assert.ok(delay <= TTS_ROUTE_RETRY_MAX_DELAY_MS * 1.2, `attempt ${attempt} produced ${delay}`)
    }
  }
  // Sections of one episode fail against the same provider window; an
  // unjittered schedule would send them all back at the same instant.
  assert.notEqual(ttsRouteRetryDelayMs(0, env, () => 0), ttsRouteRetryDelayMs(0, env, () => 1))

  // Overridable for tests and for an operator; junk is ignored.
  assert.equal(ttsRouteRetryDelayMs(0, { [TTS_ROUTE_RETRY_BASE_MS_ENV]: '10' }, mid), 10)
  assert.equal(ttsRouteRetryDelayMs(0, { [TTS_ROUTE_RETRY_BASE_MS_ENV]: 'soon' }, mid), TTS_ROUTE_RETRY_BASE_MS)
})

test('a retry identity is derived from the failure, never minted fresh', () => {
  const base = 'demo:TN0001:audio:TN0001_chapter_01.mp3'

  // Same failure ⇒ same identity. This is what stops a replayed retry — after
  // a crash, a lost response, a restart — from buying a second job.
  assert.equal(nextTtsRouteRetryIdentity(base, 'job-a'), nextTtsRouteRetryIdentity(base, 'job-a'))
  // A different failed job is a different attempt.
  assert.notEqual(nextTtsRouteRetryIdentity(base, 'job-a'), nextTtsRouteRetryIdentity(base, 'job-b'))
  // Chained, so attempt 3 is not attempt 2 — the bug that would have chapter
  // 09 replay its own dead job forever instead of asking a third time.
  const first = nextTtsRouteRetryIdentity(base, 'job-a')
  const second = nextTtsRouteRetryIdentity(first, 'job-b')
  assert.notEqual(first, second)
  assert.notEqual(second, base)
  assert.equal(second, nextTtsRouteRetryIdentity(nextTtsRouteRetryIdentity(base, 'job-a'), 'job-b'))
  assert.match(first, /:route-retry:[0-9a-f]{12}$/)
  // Never derived from a clock or a counter.
  const policy = readFileSync(new URL('../services/tts-capacity-retry.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(policy.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /Date\.now|randomUUID|Math\.random\(\)\s*\.toString/)
})

void test('an exhausted route retries into exactly one new job, and a replay buys nothing', async (suite) => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  let previousGenStudioUrl = ''

  try {
    const settings = await import('../services/app-settings.js')
    // Restored below. This file sorts early in the suite, so a mock base URL
    // left behind here would outlive its server for every file after it.
    previousGenStudioUrl = await settings.getGenStudioUrl()
    await settings.setGenStudioUrl(service.baseUrl)
    const client = await import('../lib/genstudio-client.js')

    const base = 'demo:TN0001:audio:TN0001_chapter_09.mp3'
    const speak = (requestIdentity: string, outFile: string) =>
      client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, outFile), {
        text: 'Chapter nine exists only inside the deterministic mock service.',
        voiceId: 'mock-voice',
        modelId: 'mock-tts-model',
        maxInputCharacters: 5_000,
        speed: 1,
        requestIdentity,
        idempotencyKey: client.buildGenStudioSubmission({
          text: 'Chapter nine exists only inside the deterministic mock service.',
          voiceId: 'mock-voice',
          modelId: 'mock-tts-model',
          maxInputCharacters: 5_000,
          speed: 1,
          requestIdentity,
        }).idempotencyKey,
      })

    let exhaustedJobId = ''

    await suite.test('the first attempt settles failed with nothing charged', async () => {
      service.queueScenario('tts', {
        states: ['accepted', 'failed'],
        failureCode: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
      })
      const error = await speak(base, 'chapter-09.mp3').then(
        () => null,
        (e: unknown) => e,
      )
      assert.ok(error instanceof GenStudioTtsTerminalFailureError)
      assert.equal(error.failureCode, GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE)
      // The classifier agrees with the wire, not with a message match.
      assert.equal(isGenStudioRouteExhausted(error), true)
      assert.equal(service.providerSubmissionCount('tts'), 1)
      exhaustedJobId = error.jobId
      assert.ok(exhaustedJobId)
      // GenStudio released the whole reservation, which is what makes asking
      // again free of charge rather than merely cheap.
      const credits = service.creditSnapshot(exhaustedJobId)
      assert.equal(credits.final, 0)
      assert.equal(credits.returned, credits.reserved)
    })

    await suite.test('the derived retry submits one new job and saves the audio', async () => {
      const retryIdentity = nextTtsRouteRetryIdentity(base, exhaustedJobId)
      assert.notEqual(retryIdentity, base)
      await speak(retryIdentity, 'chapter-09.mp3')
      await fs.access(path.join(temp.dir, 'chapter-09.mp3'))
      // One, not two: the retry is new work, and it is only new once.
      assert.equal(service.providerSubmissionCount('tts'), 2)
    })

    await suite.test('replaying that retry returns the job it already has', async () => {
      // A crash between submit and save, an app restart, a lost response —
      // all re-derive the identical identity, and GenStudio hands back the
      // job rather than selling another.
      const retryIdentity = nextTtsRouteRetryIdentity(base, exhaustedJobId)
      await speak(retryIdentity, 'chapter-09-again.mp3')
      await fs.access(path.join(temp.dir, 'chapter-09-again.mp3'))
      assert.equal(service.providerSubmissionCount('tts'), 2)
    })

    await suite.test('the dead first identity still resolves to its dead job', async () => {
      // Which is exactly why a retry has to derive a new identity at all: the
      // original key can never produce audio again, however often it is sent.
      const error = await speak(base, 'chapter-09-replay.mp3').then(() => null, (e: unknown) => e)
      assert.ok(error instanceof GenStudioTtsTerminalFailureError)
      assert.equal(error.jobId, exhaustedJobId)
      assert.equal(service.providerSubmissionCount('tts'), 2)
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

test('the audio generator paces, retries and reports what it is doing', () => {
  const source = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')

  // Staged by the tighter selected-model hint and keyed account burst. Neither
  // publication is remote authority; the central GenStudio admission gate is.
  assert.match(source, /resolveGenStudioTtsFanout\(\s*tasks\.length,\s*ttsModel\.provider_submit_concurrency,\s*admission\.burst_concurrency_ceiling,?\s*\)/)
  assert.doesNotMatch(source, /resolveGenStudioLocalFanout/)

  // Retried on the codes that prove nothing was bought, and bounded.
  //
  // TWO of them since 1.4.25, not one. `CLOUD_PROVIDER_EXHAUSTED` means every
  // provider route declined; `SITE_PLACEMENT_EXHAUSTED` means GenStudio itself
  // had no free MACHINE. Both release the whole reservation, and only the first
  // was covered — so VOICE_TTS lost five sections to the second on 13-15 August
  // and nobody noticed, because a dropped section looks like ordinary
  // flakiness. See `lib/genstudio-fleet-busy.ts`.
  // Since 1.4.249 a busy fleet waits on the SHARED fleet ladder (fleetBusyRetryPlan), and the
  // route/transport retries keep their own bounded count, so a long wait never uses them up.
  assert.match(source, /const fleetPlan = fleetBusyRetryPlan\(e, 'tts', fleetBusyRetries\)/)
  assert.match(source, /const worthRetrying = !!fleetPlan\s*\n\s*\|\| \(\(isGenStudioRouteExhausted\(e\) \|\| transportFailure\) && routeAttempt < TTS_ROUTE_RETRY_MAX_ATTEMPTS\)/)
  assert.match(source, /if \(!worthRetrying\) \{/)
  assert.match(source, /nextTtsRouteRetryIdentity\(submissionIdentity, e\.jobId/)
  // The retry must not reclaim the job it is replacing.
  assert.match(source, /recoveryEntry = null/)

  // The durable identity still owns the manifest hash, so a resumed run
  // recognises its own entry instead of resubmitting paid work.
  assert.match(source, /const inputHash = chunkInputHash\(chunkFilename, task\.chunkText\)/)
  assert.match(source, /requestIdentity: `\$\{project_slug\}:\$\{episode_id\.toUpperCase\(\)\}:audio:\$\{chunkFilename\}`,/)

  // Live per-item state, published on every transition including the wait.
  assert.match(source, /job\.item_progress = \{/)
  assert.match(source, /state: 'waiting_retry'/)
})
