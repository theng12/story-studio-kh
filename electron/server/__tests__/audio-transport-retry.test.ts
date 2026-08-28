/**
 * A dropped connection is retried, and retried onto the SAME job.
 *
 * The failure this pins. Every generator decides whether to ask again by
 * asking whether the failure PROVES no provider did any work — and every one
 * of those checks begins `error instanceof GenStudioTerminalFailureError`. A
 * dropped connection is a bare `TypeError: fetch failed` from undici, so it
 * matched neither predicate, `worthRetrying` came out false, and the chapter
 * was abandoned on its FIRST attempt with the raw text shown to the owner:
 *
 *     9 section(s) failed: Chapter 1: fetch failed; Chapter 2: fetch failed; …
 *
 * That reads the rule backwards. A request that was never answered is the case
 * where asking again is MOST clearly safe — nothing can have been charged for a
 * connection that never completed.
 *
 * Why it cost whole batches rather than the odd chapter. The client's own
 * retry ladder is four attempts of 500ms/1s/2s — about 3.5 seconds, which
 * covers a blip and nothing else. During a GenStudio restart the generator
 * kept marching down the section list at the admission pool's fallback pace,
 * writing each one off after 3.5s. The generator's ladder is minutes, which is
 * the scale a restart actually needs.
 *
 * THE DANGEROUS HALF, and what these tests are really for. A settled failure
 * is dead — its idempotency key replays the same failure forever — so those
 * retries mint a DERIVED identity. A dropped connection is the opposite: the
 * request may well have been received, so a fresh identity would be a fresh
 * key, a second job, and a second charge for one chapter. The identity must
 * NOT move. That is asserted here against the mock service's real idempotency
 * contract, not against the code.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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
  GenStudioTtsTerminalFailureError,
} from '../lib/genstudio-client.js'
import { isTransportFailure } from '../lib/http-retry.js'

test('a dropped connection is recognised, and a settled failure is never mistaken for one', () => {
  // The shapes undici actually produces. `fetch failed` is the top-level
  // message and the real reason hides in `cause`, which is why the chain is
  // walked rather than only the message read.
  assert.equal(isTransportFailure(new TypeError('fetch failed')), true)
  assert.equal(
    isTransportFailure(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8790'), { code: 'ECONNREFUSED' }),
    })),
    true,
  )
  assert.equal(
    isTransportFailure(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    })),
    true,
  )
  assert.equal(isTransportFailure(new Error('socket hang up')), true)
  assert.equal(isTransportFailure(Object.assign(new Error('other side closed'), {
    code: 'UND_ERR_SOCKET',
  })), true)
  assert.equal(isTransportFailure(new Error('getaddrinfo EAI_AGAIN api.example')), true)

  // THE DANGEROUS FALSE POSITIVE. Every one of these describes work a provider
  // may already have been paid for. Matching any of them here would resubmit
  // it and charge twice — the one mistake this classifier must never make.
  assert.equal(isTransportFailure(new GenStudioTtsTerminalFailureError({
    id: 'tts-failed', state: 'failed', failure_code: 'CLOUD_PROVIDER_FAILED',
  })), false)
  assert.equal(isTransportFailure(new GenStudioTtsTerminalFailureError({
    id: 'tts-uncertain', state: 'failed', failure_code: 'CLOUD_SUBMISSION_UNCERTAIN',
  })), false)
  assert.equal(isTransportFailure(new GenStudioTtsTerminalFailureError({
    id: 'tts-exhausted', state: 'failed', failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
  })), false)
  assert.equal(isTransportFailure(new GenStudioApiError(500, 'GenStudio KH is unwell')), false)
  assert.equal(isTransportFailure(new GenStudioApiError(402, 'insufficient credits')), false)
  assert.equal(isTransportFailure(new Error('GenStudio KH image download failed (HTTP 503)')), false)

  // A cancel is the owner's instruction. It can carry a torn-down socket in
  // its cause, and retrying it would overrule him.
  assert.equal(isTransportFailure(new Error('Cancelled by user')), false)
  assert.equal(isTransportFailure(Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  })), false)

  assert.equal(isTransportFailure(null), false)
  assert.equal(isTransportFailure('fetch failed'), false)
})

void test('a chapter that lost its connection replays onto the same job, never a second one', async (suite) => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  let previousGenStudioUrl = ''

  // A port that is genuinely closed, so the failure is a real undici
  // `fetch failed` rather than a hand-made Error that only looks like one.
  const deadPort = await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

  try {
    const settings = await import('../services/app-settings.js')
    previousGenStudioUrl = await settings.getGenStudioUrl()
    const client = await import('../lib/genstudio-client.js')

    const text = 'Chapter three exists only inside the deterministic mock service.'
    const submission = (requestIdentity: string) => ({
      text, voiceId: 'mock-voice', modelId: 'mock-tts-model',
      maxInputCharacters: 5_000, speed: 1, requestIdentity,
    })
    const speak = (requestIdentity: string, outFile: string) =>
      client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, outFile), {
        ...submission(requestIdentity),
        idempotencyKey: client.buildGenStudioSubmission(submission(requestIdentity)).idempotencyKey,
      })

    // The chapter's durable identity. It must be the SAME string on both
    // sides of the outage — that is the whole property under test.
    const identity = 'demo:TN0001:audio:TN0001_chapter_03.mp3'

    await suite.test('the outage surfaces as a transport failure, and nothing was bought', async () => {
      await settings.setGenStudioUrl(`http://127.0.0.1:${deadPort}`)
      client.clearGenStudioCatalogCache()
      const error = await speak(identity, 'chapter-03.mp3').then(() => null, (e: unknown) => e)

      assert.ok(error instanceof Error, 'a closed port must fail, not resolve')
      assert.equal(isTransportFailure(error), true, `unexpected failure shape: ${String(error)}`)
      // Neither settled-failure predicate sees it — which is exactly why the
      // generator used to abandon the chapter here.
      assert.equal(error instanceof GenStudioTtsTerminalFailureError, false)
      assert.equal(service.providerSubmissionCount('tts'), 0, 'nothing reached GenStudio at all')
    })

    await suite.test('retrying the SAME identity once the service returns buys exactly one job', async () => {
      await settings.setGenStudioUrl(service.baseUrl)
      client.clearGenStudioCatalogCache()
      await speak(identity, 'chapter-03.mp3')
      await fs.access(path.join(temp.dir, 'chapter-03.mp3'))
      assert.equal(service.providerSubmissionCount('tts'), 1)
    })

    await suite.test('and replaying it again still buys nothing — the key is the receipt', async () => {
      // The case the identity rule exists for: if the connection had dropped
      // AFTER GenStudio accepted the work, this replay is what reconnects to
      // it instead of paying for a second rendering of the same chapter.
      await speak(identity, 'chapter-03-again.mp3')
      await fs.access(path.join(temp.dir, 'chapter-03-again.mp3'))
      assert.equal(service.providerSubmissionCount('tts'), 1)
    })

    await suite.test('a DERIVED identity would have bought a second job — the cost of getting this wrong', async () => {
      // Not a recommendation; a measurement of the mistake. This is what the
      // settled-failure path does on purpose, and what a transport retry must
      // never do, priced in submissions.
      const { nextTtsRouteRetryIdentity } = await import('../services/tts-capacity-retry.js')
      await speak(nextTtsRouteRetryIdentity(identity, 'some-job'), 'chapter-03-derived.mp3')
      assert.equal(service.providerSubmissionCount('tts'), 2, 'a new identity is a new charge')
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

test('the audio generator keeps its identity on a dropped connection, and derives one otherwise', () => {
  const source = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')

  // The transport class is retryable at all.
  assert.match(source, /const transportFailure = isTransportFailure\(e\)/)
  assert.match(source, /const worthRetrying = isGenStudioRouteExhausted\(e\) \|\| isFleetBusyFailure\(e, 'tts'\)\s*\n\s*\|\| transportFailure/)

  // And the safety half: the derived identity is reached ONLY on the
  // settled-failure branch. If these two ever swap, one chapter is billed
  // twice per outage.
  assert.match(source, /if \(transportFailure\) \{/)
  assert.match(source, /\} else \{[\s\S]*?nextTtsRouteRetryIdentity\(submissionIdentity, e\.jobId/)
  assert.match(source, /\} else \{[\s\S]*?recoveryEntry = null/)
  const transportBranch = source.slice(
    source.indexOf('if (transportFailure) {'),
    source.indexOf('} else {', source.indexOf('if (transportFailure) {')),
  )
  assert.ok(transportBranch.length > 0, 'the transport branch must exist')
  assert.doesNotMatch(transportBranch, /nextTtsRouteRetryIdentity/,
    'a dropped connection must never mint a new idempotency key')
  assert.doesNotMatch(transportBranch, /recoveryEntry = null/,
    'a dropped connection must keep the accepted job it may already have')
  // It re-reads the manifest, so a job accepted just before the drop is
  // reclaimed rather than resubmitted.
  assert.match(transportBranch, /readManifest\(audioDir\)/)
})
