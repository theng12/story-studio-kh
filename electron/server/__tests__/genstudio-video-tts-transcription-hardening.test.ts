/**
 * Video / TTS / transcription get the same hardening images and chat already
 * received: terminal classification from JobState only, typed terminal errors,
 * and a retry identity that is FRESH after a terminal failure yet STABLE when a
 * submit response is lost.
 *
 * Everything runs against the in-process mock GenStudio service — zero network,
 * zero spend. The mock enforces the real idempotency contract (a repeated
 * Idempotency-Key replays the SAME job instead of creating another), so "did
 * this submit new paid work?" is answered by `providerSubmissionCount(...)`
 * rather than by inspection.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
} from './fixtures/mock-genstudio-service.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

void test('GenStudio video, TTS and transcription settle, refuse to reopen, and never double-charge', async (suite) => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const sourceImage = path.join(temp.dir, 'scene.png')
  const sourceAudio = path.join(temp.dir, 'narration.wav')
  await fs.writeFile(sourceImage, ONE_PIXEL_PNG)
  await fs.writeFile(sourceAudio, Buffer.from('RIFF-mock-story-audio'))

  try {
    const settings = await import('../services/app-settings.js')
    await settings.setGenStudioUrl(service.baseUrl)
    const client = await import('../lib/genstudio-client.js')

    const submitVideo = (requestIdentity: string, idempotencyKey?: string) =>
      client.generateVideoWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        prompt: 'A slow push-in over the moonlit temple.',
        modelId: 'mock-video-v1',
        sourceImagePath: sourceImage,
        aspectRatio: '16:9',
        durationSeconds: 5,
        resolution: '720p',
        requestIdentity,
        idempotencyKey,
      })

    const submitTts = (requestIdentity: string, outFile: string, idempotencyKey?: string) =>
      client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, outFile), {
        text: 'This speech exists only inside the deterministic mock service.',
        voiceId: 'mock-voice',
        modelId: 'mock-tts-model',
        // The boundary a live /v1/tts/models row would supply.
        maxInputCharacters: 12_000,
        speed: 1,
        requestIdentity,
        idempotencyKey,
      })

    const submitTranscription = (requestIdentity: string, idempotencyKey?: string) =>
      client.transcribeWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        audioPath: sourceAudio,
        modelId: 'mock-whisper-v1',
        requestIdentity,
        idempotencyKey,
        language: 'en',
      })

    // ── VIDEO ────────────────────────────────────────────────────────────────

    await suite.test('video polls accepted → running → succeeded', async () => {
      service.reset()
      service.queueScenario('video', { states: ['accepted', 'dispatched', 'running', 'succeeded'] })
      const states: string[] = []
      const result = await client.generateVideoWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        prompt: 'A slow push-in over the moonlit temple.',
        modelId: 'mock-video-v1',
        sourceImagePath: sourceImage,
        aspectRatio: '16:9',
        durationSeconds: 5,
        resolution: '720p',
        requestIdentity: 'video:poll',
        onState: state => { states.push(state) },
      })
      assert.equal(service.providerSubmissionCount('video'), 1)
      assert.ok(result.videoUrl.startsWith(service.baseUrl))
      assert.deepEqual(states, ['accepted', 'dispatched', 'running', 'succeeded'])
    })

    await suite.test('a FAILED video job is terminal, typed, and is never reopened by polling', async () => {
      service.reset()
      service.queueScenario('video', { states: ['failed'], failureCode: 'VIDEO_PROVIDER_ERROR' })
      let dead = ''
      await assert.rejects(
        submitVideo('video:terminal'),
        (error: unknown) => {
          assert.ok(error instanceof client.GenStudioVideoTerminalFailureError)
          assert.equal(error.modality, 'video')
          assert.equal(error.state, 'failed')
          assert.equal(error.failureCode, 'VIDEO_PROVIDER_ERROR')
          dead = error.jobId
          return true
        },
      )
      assert.equal(service.providerSubmissionCount('video'), 1)

      // Reconnecting to it re-reads the record ONCE and refuses; it does not
      // loop, and it does not create a replacement.
      const pollsBefore = service.pollCount(dead)
      await assert.rejects(
        client.recoverVideoWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, dead, {
          prompt: 'unused', modelId: 'mock-video-v1', sourceImagePath: sourceImage,
          aspectRatio: '16:9', durationSeconds: 5, resolution: '720p',
        }),
        (error: unknown) => error instanceof client.GenStudioVideoTerminalFailureError,
      )
      assert.equal(service.pollCount(dead) - pollsBefore, 1, 'a settled job is read once, not polled')
      assert.equal(service.providerSubmissionCount('video'), 1)
    })

    await suite.test('a lost video submit response yields EXACTLY ONE paid submission', async () => {
      service.reset()
      service.queueScenario('video', { states: ['succeeded'], dropFirstSubmitResponse: true })
      // The caller persisted this key before the POST, exactly as scene-clip.ts does.
      const persistedKey = 'story-video-lost-response-fixture-key'

      const first = await submitVideo('video:lost', persistedKey)
      assert.equal(service.providerSubmissionCount('video'), 1, 'the dropped response created exactly one job')
      assert.ok(service.replayCount(first.jobId) >= 1, 'the retry replayed rather than created')

      // A later attempt that reads the same persisted key back re-attaches.
      const again = await submitVideo('video:lost', persistedKey)
      assert.equal(again.jobId, first.jobId)
      assert.equal(service.providerSubmissionCount('video'), 1, 'no second paid job')
    })

    await suite.test('a deliberate video retry after a terminal failure submits exactly ONE new job', async () => {
      service.reset()
      service.queueScenario('video', { states: ['failed'], failureCode: 'VIDEO_PROVIDER_ERROR' })
      const baseScope = 'missing'
      const baseIdentity = 'proj:EP01:scene-7:motion'

      await assert.rejects(
        submitVideo(baseIdentity),
        (error: unknown) => error instanceof client.GenStudioVideoTerminalFailureError,
      )
      const deadJobId = service.submissions[0]!.jobId
      assert.equal(service.providerSubmissionCount('video'), 1)

      // What scene-clip.ts persists once it observes the terminal outcome.
      const failed = { task_id: deadJobId, request_scope: baseScope, last_state: 'failed' }
      const { isTerminalGenStudioClipTaskFailure } = await import('../generators/scene-clip.js')
      assert.ok(isTerminalGenStudioClipTaskFailure(failed))

      const retry = client.resolveGenStudioRetryScope(failed, baseScope, isTerminalGenStudioClipTaskFailure)
      assert.ok(retry.isRetry)
      assert.notEqual(retry.scope, baseScope)
      assert.equal(retry.previousTaskId, deadJobId)
      // Deterministic: no clock, no randomness.
      assert.equal(
        client.resolveGenStudioRetryScope(failed, baseScope, isTerminalGenStudioClipTaskFailure).scope,
        retry.scope,
      )
      assert.match(retry.scope, /^missing:retry:[0-9a-f]{12}$/)

      const fresh = await submitVideo(`${baseIdentity}:${retry.scope}`)
      assert.equal(service.providerSubmissionCount('video'), 2, 'exactly one fresh job')
      assert.notEqual(fresh.jobId, deadJobId)

      // Re-deriving the same scope replays instead of paying a third time.
      const replay = await submitVideo(`${baseIdentity}:${retry.scope}`)
      assert.equal(replay.jobId, fresh.jobId)
      assert.equal(service.providerSubmissionCount('video'), 2)
    })

    await suite.test('video jobs never fabricate released_credits', async () => {
      service.reset()
      const result = await submitVideo('video:settlement')
      const body = service.submissions.find(submission => submission.jobId === result.jobId)
      assert.ok(body)
      assert.doesNotMatch(body.bodyText, /released_credits/i)
    })

    await suite.test('cancellation returns GenStudio truth without a replacement request', async () => {
      service.reset()
      service.queueScenario('tts', { states: ['accepted', 'running', 'succeeded'], reservedCredits: 5 })
      const submitted = await fetch(`${service.baseUrl}/v1/audio/jobs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
          'Idempotency-Key': 'cancel-truth-tts-001',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model_id: 'mock-tts-model', voice_id: 'mock-voice', text: 'cancel me', speed: 1 }),
      })
      const providerJob = await submitted.json() as { id: string }
      const cancelled = await client.requestGenStudioCancellation(
        'voice.tts', service.baseUrl, MOCK_GENSTUDIO_FULL_KEY, providerJob.id, {}, Date.now() + 10_000,
      )
      assert.equal(cancelled.cancelled, true)
      assert.equal(cancelled.released_credits, 5)
      assert.equal(service.providerSubmissionCount('tts'), 1)
      assert.equal(service.requests.filter(request => request.path === `/v1/jobs/${providerJob.id}/cancel`).length, 1)
    })

    await suite.test('a lost cancellation response makes one control POST and no retry', async () => {
      service.reset()
      service.queueScenario('tts', {
        states: ['accepted', 'running', 'succeeded'],
        dropFirstCancellationResponse: true,
      })
      const submitted = await fetch(`${service.baseUrl}/v1/audio/jobs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
          'Idempotency-Key': 'cancel-transport-tts-001',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model_id: 'mock-tts-model', voice_id: 'mock-voice', text: 'cancel me', speed: 1 }),
      })
      const providerJob = await submitted.json() as { id: string }
      await assert.rejects(
        client.requestGenStudioCancellation(
          'voice.tts', service.baseUrl, MOCK_GENSTUDIO_FULL_KEY, providerJob.id, {}, Date.now() + 10_000,
        ),
      )
      assert.equal(service.requests.filter(request => request.path === `/v1/jobs/${providerJob.id}/cancel`).length, 1)
      assert.equal(service.providerSubmissionCount('tts'), 1)
    })

    await suite.test('uses only the four published cancellation routes and leaves video nonterminal', async () => {
      service.reset()
      const cases: Array<{
        operation: 'voice.tts' | 'image.generation' | 'audio.transcription' | 'video.generation'
        submitPath: string
        cancelPath: (id: string) => string
        body: Record<string, unknown>
      }> = [
        { operation: 'voice.tts', submitPath: '/v1/audio/jobs', cancelPath: id => `/v1/jobs/${id}/cancel`, body: { model_id: 'mock-tts-model', voice_id: 'mock-voice', text: 'cancel', speed: 1 } },
        { operation: 'image.generation', submitPath: '/v1/images/generations', cancelPath: id => `/v1/images/${id}/cancel`, body: { model_id: 'mock-image-v1', prompt: 'cancel', aspect_ratio: '16:9' } },
        { operation: 'audio.transcription', submitPath: '/v1/audio/transcriptions', cancelPath: id => `/v1/transcriptions/${id}/cancel`, body: { model_id: 'mock-whisper-v1' } },
        { operation: 'video.generation', submitPath: '/v1/videos/generations', cancelPath: id => `/v1/videos/${id}/cancel`, body: { model_id: 'mock-video-v1', prompt: 'cancel', duration_seconds: 5, resolution: '720p' } },
      ]
      service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
      service.queueScenario('image', { states: ['accepted', 'succeeded'] })
      service.queueScenario('transcription', { states: ['accepted', 'succeeded'] })
      service.queueScenario('video', { states: ['accepted', 'running', 'succeeded'] })
      for (const entry of cases) {
        const submitted = await fetch(`${service.baseUrl}${entry.submitPath}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
            'Idempotency-Key': `cancel-route-${entry.operation}-001`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(entry.body),
        })
        const providerJob = await submitted.json() as { id: string }
        const result = await client.requestGenStudioCancellation(
          entry.operation, service.baseUrl, MOCK_GENSTUDIO_FULL_KEY, providerJob.id, {}, Date.now() + 10_000,
        )
        assert.equal(service.requests.filter(request => request.path === entry.cancelPath(providerJob.id)).length, 1)
        if (entry.operation === 'video.generation') {
          assert.equal(result.cancellation_requested, true)
          assert.notEqual(result.cancelled, true)
        } else assert.equal(result.cancelled, true)
      }
    })

    await suite.test('a pre-execution 409 is preserved for reconciliation', async () => {
      service.reset()
      service.queueScenario('image', { states: ['accepted', 'running', 'succeeded'] })
      const submitted = await fetch(`${service.baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
          'Idempotency-Key': 'cancel-409-image-001',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model_id: 'mock-image-v1', prompt: 'race', aspect_ratio: '16:9' }),
      })
      const providerJob = await submitted.json() as { id: string }
      await fetch(`${service.baseUrl}/v1/images/${providerJob.id}`, { headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}` } })
      await assert.rejects(
        client.requestGenStudioCancellation(
          'image.generation', service.baseUrl, MOCK_GENSTUDIO_FULL_KEY, providerJob.id, {}, Date.now() + 10_000,
        ),
        (error: unknown) => error instanceof client.GenStudioApiError && error.status === 409,
      )
      assert.equal(service.requests.filter(request => request.path === `/v1/images/${providerJob.id}/cancel`).length, 1)
    })

    await suite.test('refuses malformed cancellation payloads instead of inventing fields', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => Response.json({ id: 'malformed-cancel', state: 42 }, { status: 200 })
      try {
        await assert.rejects(
          client.requestGenStudioCancellation(
            'voice.tts', service.baseUrl, MOCK_GENSTUDIO_FULL_KEY, 'malformed-cancel', {}, Date.now() + 10_000,
          ),
          /valid state/,
        )
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    await suite.test('keeps zero or absent released credits literal and drops invalid optional fields', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => Response.json({
        id: 'zero-release-cancel', state: 'accepted', released_credits: 0,
        cancellable: 'not-a-boolean', cancellation_note: 5,
      }, { status: 200 })
      try {
        const result = await client.requestGenStudioCancellation(
          'voice.tts', service.baseUrl, MOCK_GENSTUDIO_FULL_KEY, 'zero-release-cancel', {}, Date.now() + 10_000,
        )
        assert.equal(result.released_credits, 0)
        assert.equal(result.cancellable, undefined)
        assert.equal(result.cancellation_note, undefined)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    // ── TTS ──────────────────────────────────────────────────────────────────

    await suite.test('TTS polls accepted → running → succeeded and surfaces released_credits', async () => {
      service.reset()
      service.queueScenario('tts', {
        states: ['accepted', 'running', 'succeeded'],
        quotedCredits: 5, reservedCredits: 5, finalCredits: 4,
      })
      const states: string[] = []
      const settlement: Array<number | null | undefined> = []
      await client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, 'poll.mp3'), {
        text: 'This speech exists only inside the deterministic mock service.',
        voiceId: 'mock-voice',
        modelId: 'mock-tts-model',
        // The boundary a live /v1/tts/models row would supply.
        maxInputCharacters: 12_000,
        speed: 1,
        requestIdentity: 'tts:poll',
        onState: state => { states.push(state) },
      })
      assert.deepEqual(states, ['accepted', 'running', 'succeeded'])
      assert.equal(service.providerSubmissionCount('tts'), 1)

      // ClientTTSJobResponse publishes released_credits; the boundary forwards
      // it verbatim rather than deriving a hold from credit_cost.
      const jobId = service.submissions.find(s => s.operation === 'tts')!.jobId
      const raw = await fetch(`${service.baseUrl}/v1/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}` },
      })
      const payload = await raw.json() as Record<string, unknown>
      settlement.push(payload.released_credits as number)
      assert.equal(settlement[0], 1, 'reserved 5, settled 4 ⇒ released 1')
    })

    await suite.test('a FAILED TTS job is terminal and typed, not a message match', async () => {
      service.reset()
      service.queueScenario('tts', { states: ['failed'], failureCode: 'VOICE_PROVIDER_RESULT_INVALID' })
      await assert.rejects(
        submitTts('tts:terminal', 'terminal.mp3'),
        (error: unknown) => {
          assert.ok(error instanceof client.GenStudioTtsTerminalFailureError)
          assert.equal(error.modality, 'tts')
          assert.equal(error.failureCode, 'VOICE_PROVIDER_RESULT_INVALID')
          // The historical wording is preserved for operators.
          assert.match(error.message, /No fallback route was attempted/)
          return true
        },
      )
      assert.equal(service.providerSubmissionCount('tts'), 1, 'a failed job is never silently replaced')
    })

    await suite.test('a settled TTS job whose artifact is gone is terminal, not retryable churn', async () => {
      service.reset()
      service.queueScenario('tts', { states: ['succeeded'], artifactExpired: true })
      await assert.rejects(
        submitTts('tts:expired', 'expired.mp3'),
        (error: unknown) => {
          assert.ok(error instanceof client.GenStudioTtsArtifactUnavailableError)
          assert.equal(error.modality, 'tts')
          assert.equal(error.status, 404)
          return true
        },
      )
      assert.equal(service.providerSubmissionCount('tts'), 1)
    })

    await suite.test('a lost TTS submit response yields EXACTLY ONE paid submission', async () => {
      service.reset()
      service.queueScenario('tts', { states: ['succeeded'], dropFirstSubmitResponse: true })
      const persistedKey = 'story-tts-lost-response-fixture-key'

      await submitTts('tts:lost', 'lost.mp3', persistedKey)
      assert.equal(service.providerSubmissionCount('tts'), 1, 'the dropped response created exactly one job')
      const jobId = service.submissions[0]!.jobId
      assert.ok(service.replayCount(jobId) >= 1)

      await submitTts('tts:lost', 'lost-again.mp3', persistedKey)
      assert.equal(service.providerSubmissionCount('tts'), 1, 'no second paid job')
    })

    await suite.test('a deliberate TTS retry after a terminal failure submits exactly ONE new job', async () => {
      service.reset()
      service.queueScenario('tts', { states: ['failed'], failureCode: 'VOICE_PROVIDER_RESULT_INVALID' })
      const identity = 'proj:EP01:audio:TN_Chapter_01.mp3'

      await assert.rejects(
        submitTts(identity, 'retry-dead.mp3'),
        (error: unknown) => error instanceof client.GenStudioTtsTerminalFailureError,
      )
      assert.equal(service.providerSubmissionCount('tts'), 1)

      // generators/audio.ts promotes a terminal entry to `:manual-retry:<jobId>`
      // and persists the derived key BEFORE the POST.
      const retryIdentity = `${identity}:manual-retry:story-job-42`
      const retryKey = client.buildGenStudioSubmission({
        text: 'This speech exists only inside the deterministic mock service.',
        voiceId: 'mock-voice',
        // The product a live /v1/tts/models row would supply.
        modelId: 'mock-tts-model',
        // The boundary a live /v1/tts/models row would supply.
        maxInputCharacters: 12_000,
        speed: 1,
        requestIdentity: retryIdentity,
      }).idempotencyKey
      await submitTts(retryIdentity, 'retry-fresh.mp3', retryKey)
      assert.equal(service.providerSubmissionCount('tts'), 2, 'exactly one fresh job')

      // Re-reading the persisted key replays it rather than paying again.
      await submitTts(retryIdentity, 'retry-replay.mp3', retryKey)
      assert.equal(service.providerSubmissionCount('tts'), 2)
    })

    // ── TRANSCRIPTION ────────────────────────────────────────────────────────

    await suite.test('transcription polls accepted → running → succeeded and surfaces released_credits', async () => {
      service.reset()
      service.queueScenario('transcription', {
        states: ['accepted', 'running', 'succeeded'],
        quotedCredits: 7, reservedCredits: 7, finalCredits: 5,
      })
      const states: string[] = []
      const result = await client.transcribeWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        audioPath: sourceAudio,
        modelId: 'mock-whisper-v1',
        requestIdentity: 'stt:poll',
        language: 'en',
        onState: state => { states.push(state) },
      })
      assert.deepEqual(states, ['accepted', 'running', 'succeeded'])
      assert.match(result.srt, /Hello from mock GenStudio/)
      assert.equal(service.providerSubmissionCount('transcription'), 1)

      const raw = await fetch(`${service.baseUrl}/v1/transcriptions/${result.jobId}`, {
        headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}` },
      })
      const payload = await raw.json() as Record<string, unknown>
      assert.equal(payload.released_credits, 2, 'reserved 7, settled 5 ⇒ released 2')
    })

    await suite.test('a FAILED transcription is terminal and its recovery refuses to reopen it', async () => {
      service.reset()
      service.queueScenario('transcription', { states: ['failed'], failureCode: 'STT_PROVIDER_ERROR' })
      let dead = ''
      await assert.rejects(
        submitTranscription('stt:terminal'),
        (error: unknown) => {
          assert.ok(error instanceof client.GenStudioTranscriptionTerminalFailureError)
          assert.equal(error.modality, 'transcription')
          assert.equal(error.failureCode, 'STT_PROVIDER_ERROR')
          assert.match(error.message, /No fallback route was attempted/)
          dead = error.jobId
          return true
        },
      )
      assert.equal(service.providerSubmissionCount('transcription'), 1)

      const pollsBefore = service.pollCount(dead)
      await assert.rejects(
        client.recoverTranscriptionWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, dead, {}),
        (error: unknown) => error instanceof client.GenStudioTranscriptionTerminalFailureError,
      )
      assert.equal(service.pollCount(dead) - pollsBefore, 1, 'a settled job is read once, not polled')
      assert.equal(service.providerSubmissionCount('transcription'), 1)
    })

    await suite.test('a lost transcription submit response yields EXACTLY ONE paid submission', async () => {
      service.reset()
      service.queueScenario('transcription', { states: ['succeeded'], dropFirstSubmitResponse: true })
      const persistedKey = 'story-stt-lost-response-fixture-key'

      const first = await submitTranscription('stt:lost', persistedKey)
      assert.equal(
        service.providerSubmissionCount('transcription'), 1,
        'the dropped confirm response created exactly one job',
      )
      assert.ok(service.replayCount(first.jobId) >= 1)

      const again = await submitTranscription('stt:lost', persistedKey)
      assert.equal(again.jobId, first.jobId)
      assert.equal(service.providerSubmissionCount('transcription'), 1, 'no second paid job')
    })

    await suite.test('a deliberate transcription retry after a terminal failure submits exactly ONE new job', async () => {
      service.reset()
      service.queueScenario('transcription', { states: ['failed'], failureCode: 'STT_PROVIDER_ERROR' })
      const identity = 'proj:EP01:transcription:EP01_whisper.srt'
      const fileSha256 = 'a'.repeat(64)
      const baseKey = client.buildGenStudioTranscriptionIdempotencyKey({
        requestIdentity: identity, fileSha256, modelId: 'mock-whisper-v1', language: 'en',
      })

      await assert.rejects(
        submitTranscription(identity, baseKey),
        (error: unknown) => error instanceof client.GenStudioTranscriptionTerminalFailureError,
      )
      assert.equal(service.providerSubmissionCount('transcription'), 1)

      const retryKey = client.buildGenStudioTranscriptionIdempotencyKey({
        requestIdentity: `${identity}:manual-retry:story-job-42`,
        fileSha256, modelId: 'mock-whisper-v1', language: 'en',
      })
      assert.notEqual(retryKey, baseKey)
      await submitTranscription(identity, retryKey)
      assert.equal(service.providerSubmissionCount('transcription'), 2, 'exactly one fresh job')

      // The persisted retry key replays; it does not pay a third time.
      await submitTranscription(identity, retryKey)
      assert.equal(service.providerSubmissionCount('transcription'), 2)
    })

    await suite.test('an expired transcription artifact is typed terminal, not a generic download error', async () => {
      service.reset()
      service.queueScenario('transcription', { states: ['succeeded'], artifactExpired: true })
      await assert.rejects(
        submitTranscription('stt:expired'),
        (error: unknown) => {
          assert.ok(error instanceof client.GenStudioTranscriptionArtifactUnavailableError)
          assert.equal(error.modality, 'transcription')
          assert.equal(error.status, 404)
          return true
        },
      )
      assert.equal(service.providerSubmissionCount('transcription'), 1)
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

void test('terminal classification uses JobState only, and cancellation is a boolean', async () => {
  const client = await import('../lib/genstudio-client.js')
  for (const state of ['accepted', 'reserved', 'dispatched', 'running', 'validating', 'reconciling']) {
    assert.equal(client.isTerminalGenStudioJobState(state), false, `${state} must stay pollable`)
    assert.equal(client.isSettledGenStudioJob({ state }), false)
  }
  assert.equal(client.isTerminalGenStudioJobState('succeeded'), true)
  assert.equal(client.isTerminalGenStudioJobState('failed'), true)
  // There is NO 'cancelled' / 'rejected' JobState in the GenStudio contract.
  assert.equal(client.isTerminalGenStudioJobState('cancelled'), false)
  assert.equal(client.isTerminalGenStudioJobState('rejected'), false)
  // Cancellation rides on the boolean, for every modality.
  assert.equal(client.isSettledGenStudioJob({ state: 'running', cancelled: true }), true)

  // Every modality's settled outcome is recognised by type alone.
  assert.ok(client.isGenStudioSettledOutcomeError(
    new client.GenStudioVideoTerminalFailureError({ id: 'v1', state: 'failed' }),
  ))
  assert.ok(client.isGenStudioSettledOutcomeError(
    new client.GenStudioTtsTerminalFailureError({ id: 't1', state: 'failed' }),
  ))
  assert.ok(client.isGenStudioSettledOutcomeError(
    new client.GenStudioTranscriptionTerminalFailureError({ id: 's1', state: 'failed' }),
  ))
  assert.ok(client.isGenStudioSettledOutcomeError(new client.GenStudioTtsArtifactUnavailableError('t1', 410)))
  assert.ok(client.isGenStudioSettledOutcomeError(new client.GenStudioTranscriptionQuoteExpiredError(410, 'gone')))
  assert.equal(client.isGenStudioSettledOutcomeError(new client.GenStudioApiError(503, 'busy')), false)

  // A cancelled job carries the same terminal typing as a failed one.
  const cancelled = new client.GenStudioVideoTerminalFailureError({ id: 'v2', state: 'running', cancelled: true })
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.state, 'failed')
})

void test('a retry scope is fresh after a terminal failure, stable otherwise, and bounded', async () => {
  const client = await import('../lib/genstudio-client.js')
  const isTerminal = (entry: { task_id?: string; last_state?: string }) =>
    Boolean(entry.task_id && entry.last_state === 'failed')

  const failed = { task_id: 'job-a', request_scope: 'missing', last_state: 'failed' }
  const first = client.resolveGenStudioRetryScope(failed, 'missing', isTerminal)
  assert.equal(client.resolveGenStudioRetryScope(failed, 'missing', isTerminal).scope, first.scope)
  assert.match(first.scope, /^missing:retry:[0-9a-f]{12}$/)

  // A second terminal failure chains without unbounded growth.
  const failedAgain = { task_id: 'job-b', request_scope: first.scope, last_state: 'failed' }
  const second = client.resolveGenStudioRetryScope(failedAgain, 'missing', isTerminal)
  assert.notEqual(second.scope, first.scope)
  assert.equal(second.scope.length, first.scope.length)

  // A prepared (not yet settled) entry keeps its scope so a lost response replays.
  const prepared = { task_id: '', request_scope: second.scope, last_state: 'prepared' }
  assert.equal(client.resolveGenStudioRetryScope(prepared, 'missing', isTerminal).scope, second.scope)

  // A different deliberate attempt never inherits another attempt's retry chain.
  assert.equal(client.resolveGenStudioRetryScope(failedAgain, 'force:job-77', isTerminal).scope, 'force:job-77')
  assert.equal(client.resolveGenStudioRetryScope(null, 'missing', isTerminal).scope, 'missing')
})
