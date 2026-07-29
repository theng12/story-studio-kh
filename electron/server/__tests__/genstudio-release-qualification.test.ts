import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
  type MockGenStudioScope,
} from './fixtures/mock-genstudio-service.js'

const NO_SCOPES_KEY = 'gsk_mock_story_no_scopes'
const CHAT_CATALOG_ONLY_KEY = 'gsk_mock_story_chat_catalog_only'

function fetchUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function importedModules(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match => match[1]!)
}

void test('deterministic zero-spend GenStudio release qualification', async (suite) => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  process.env.STORY_STUDIO_GENSTUDIO_QUALIFICATION = 'mock-only'

  try {
    const settings = await import('../services/app-settings.js')
    await settings.setGenStudioUrl(service.baseUrl)
    const client = await import('../lib/genstudio-client.js')

    service.registerKey(NO_SCOPES_KEY, [])
    service.registerKey(CHAT_CATALOG_ONLY_KEY, ['models:read', 'usage:read'])
    globalThis.fetch = async (input, init) => {
      const url = new URL(fetchUrl(input))
      assert.equal(
        url.origin,
        service.baseUrl,
        `GenStudio qualification blocked non-mock network access to ${url.origin}`,
      )
      return originalFetch(input, init)
    }

    const audioPath = path.join(temp.dir, 'qualification.wav')
    await fs.writeFile(audioPath, Buffer.from('RIFF-mock-story-audio'))

    await suite.test('loads provider-owned catalogs and fails closed on missing key scopes', async () => {
      service.reset()
      const [capabilities, voices, chat, image, transcription, video] = await Promise.all([
        client.listModelCapabilities(MOCK_GENSTUDIO_FULL_KEY),
        client.listVoices(MOCK_GENSTUDIO_FULL_KEY),
        client.listChatModels(MOCK_GENSTUDIO_FULL_KEY),
        client.listImageModels(MOCK_GENSTUDIO_FULL_KEY),
        client.listTranscriptionModels(MOCK_GENSTUDIO_FULL_KEY),
        client.listVideoModels(MOCK_GENSTUDIO_FULL_KEY),
      ])

      assert.deepEqual(capabilities.map(model => model.id), ['mock-tts-v1', 'mock-chat-v1'])
      assert.deepEqual(voices.map(voice => voice.id), ['mock-voice'])
      assert.deepEqual(chat.map(model => model.id), ['mock-chat-v1'])
      assert.deepEqual(image.map(model => model.id), ['mock-image-v1'])
      assert.deepEqual(transcription.map(model => model.id), ['mock-whisper-v1'])
      assert.deepEqual(video.map(model => model.id), ['mock-video-v1'])
      assert.ok(service.requests.every(request => request.authorization === `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`))

      const missingCatalogScopes: Array<{
        scope: MockGenStudioScope
        load: () => Promise<unknown>
      }> = [
        { scope: 'models:read', load: () => client.listModelCapabilities(NO_SCOPES_KEY) },
        { scope: 'voices:read', load: () => client.listVoices(NO_SCOPES_KEY) },
        { scope: 'images:generate', load: () => client.listImageModels(NO_SCOPES_KEY) },
        { scope: 'audio:transcribe', load: () => client.listTranscriptionModels(NO_SCOPES_KEY) },
      ]
      for (const entry of missingCatalogScopes) {
        await assert.rejects(entry.load(), new RegExp(`missing required scope: ${entry.scope}`))
      }
    })

    await suite.test('rejects every generation scope before creating a GenStudio job', async () => {
      service.reset()
      await assert.rejects(
        client.callChatWithGenStudio(CHAT_CATALOG_ONLY_KEY, {
          modelId: 'mock-chat-v1',
          system: '',
          userMessage: 'This must not create work.',
          requestIdentity: 'qualification:scope:chat',
        }),
        /missing required scope: chat:generate/,
      )
      await assert.rejects(
        client.generateImageWithGenStudio(NO_SCOPES_KEY, {
          prompt: 'This image request must fail closed.',
          modelId: 'mock-image-v1',
          aspectRatio: '16:9',
          steps: 4,
          requestIdentity: 'qualification:scope:image',
        }),
        /missing required scope: images:generate/,
      )
      await assert.rejects(
        client.generateTtsToFile(NO_SCOPES_KEY, path.join(temp.dir, 'scope.mp3'), {
          text: 'This TTS request must fail closed.',
          voiceId: 'mock-voice',
          speed: 1,
          requestIdentity: 'qualification:scope:tts',
        }),
        /missing required scope: tts:generate/,
      )
      await assert.rejects(
        client.transcribeWithGenStudio(NO_SCOPES_KEY, {
          audioPath,
          modelId: 'mock-whisper-v1',
          requestIdentity: 'qualification:scope:transcription',
        }),
        /missing required scope: audio:transcribe/,
      )
      assert.equal(service.jobCount(), 0)
      assert.equal(service.providerSubmissionCount(), 0)
    })

    await suite.test('replays an uncertain LLM response with one idempotent provider submission', async () => {
      service.reset()
      service.queueScenario('chat', {
        states: ['accepted', 'reserved', 'dispatched', 'running', 'validating', 'succeeded'],
        quotedCredits: 9,
        reservedCredits: 9,
        finalCredits: 6,
        outputText: 'One durable mock response.',
        dropFirstSubmitResponse: true,
      })
      const states: string[] = []
      const accepted: Array<{ jobId: string; idempotencyKey: string }> = []
      const result = await client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        modelId: 'mock-chat-v1',
        system: 'Be deterministic.',
        userMessage: 'Return one response.',
        requestIdentity: 'qualification:chat:response-loss',
        onJobAccepted: (jobId, idempotencyKey) => { accepted.push({ jobId, idempotencyKey }) },
        onState: state => { states.push(state) },
      })

      assert.equal(result.text, 'One durable mock response.')
      assert.deepEqual(states, ['succeeded'])
      assert.equal(accepted.length, 1)
      assert.equal(service.jobCount('chat'), 1)
      assert.equal(service.providerSubmissionCount('chat'), 1)
      assert.equal(service.replayCount(result.jobId), 1)
      const submitRequests = service.requests.filter(request => (
        request.method === 'POST' && request.path === '/v1/chat/completions'
      ))
      assert.equal(submitRequests.length, 2)
      assert.equal(new Set(submitRequests.map(request => request.idempotencyKey)).size, 1)
      assert.deepEqual(service.creditSnapshot(result.jobId), {
        quoted: 9,
        reserved: 9,
        final: 6,
        returned: 3,
      })
    })

    await suite.test('completes image, TTS, and transcription jobs with verified private assets', async () => {
      service.reset()
      service.queueScenario('image', {
        states: ['succeeded'],
        quotedCredits: 7,
        reservedCredits: 7,
        finalCredits: 7,
      })
      service.queueScenario('tts', {
        states: ['succeeded'],
        quotedCredits: 5,
        reservedCredits: 5,
        finalCredits: 4,
      })
      service.queueScenario('transcription', {
        states: ['succeeded'],
        quotedCredits: 7,
        reservedCredits: 7,
        finalCredits: 7,
      })

      const imageResult = await client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        prompt: 'A deterministic one-pixel qualification image.',
        modelId: 'mock-image-v1',
        aspectRatio: '16:9',
        steps: 4,
        seed: 17,
        requestIdentity: 'qualification:image:success',
      })
      assert.match(imageResult.url, /^data:image\/png;base64,/)

      const mp3Path = path.join(temp.dir, 'qualification.mp3')
      await client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, mp3Path, {
        text: 'This speech exists only inside the deterministic mock service.',
        voiceId: 'mock-voice',
        speed: 1,
        requestIdentity: 'qualification:tts:success',
      })
      assert.ok((await fs.stat(mp3Path)).size > 0)

      const transcriptionResult = await client.transcribeWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        audioPath,
        modelId: 'mock-whisper-v1',
        requestIdentity: 'qualification:transcription:success',
        language: 'en',
      })
      assert.match(transcriptionResult.srt, /Hello from mock GenStudio/)

      assert.deepEqual(service.creditSnapshot(imageResult.jobId), {
        quoted: 7, reserved: 7, final: 7, returned: 0,
      })
      const ttsJob = service.submissions.find(submission => submission.operation === 'tts')
      assert.ok(ttsJob)
      assert.deepEqual(service.creditSnapshot(ttsJob.jobId), {
        quoted: 5, reserved: 5, final: 4, returned: 1,
      })
      assert.deepEqual(service.creditSnapshot(transcriptionResult.jobId), {
        quoted: 7, reserved: 7, final: 7, returned: 0,
      })

      for (const submission of service.submissions) {
        assert.doesNotMatch(
          submission.bodyText,
          /quoted_credits|reserved_credits|final_credits|settled_credits|returned_credits|released_credits/i,
          'Story Studio must not tell GenStudio how to quote, reserve, settle, or return credits',
        )
      }
    })

    await suite.test('cancels before submit and stops an accepted job without creating a replacement', async () => {
      service.reset()
      const preSubmit = new AbortController()
      preSubmit.abort()
      await assert.rejects(
        client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
          prompt: 'Cancelled before submission.',
          modelId: 'mock-image-v1',
          aspectRatio: '1:1',
          steps: 4,
          requestIdentity: 'qualification:image:cancel-before-submit',
          signal: preSubmit.signal,
        }),
        /Cancelled by user/,
      )
      assert.equal(service.jobCount(), 0)

      service.queueScenario('image', {
        states: ['accepted', 'running', 'succeeded'],
        quotedCredits: 8,
        reservedCredits: 8,
        finalCredits: 6,
      })
      const afterAccept = new AbortController()
      let acceptedJobId = ''
      await assert.rejects(
        client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
          prompt: 'Cancel monitoring after durable acceptance.',
          modelId: 'mock-image-v1',
          aspectRatio: '1:1',
          steps: 4,
          requestIdentity: 'qualification:image:cancel-after-accept',
          signal: afterAccept.signal,
          onJobAccepted: jobId => {
            acceptedJobId = jobId
            afterAccept.abort()
          },
        }),
        /Cancelled by user/,
      )
      assert.ok(acceptedJobId)
      assert.equal(service.jobCount('image'), 1)
      assert.equal(service.providerSubmissionCount('image'), 1)
      assert.equal(service.pollCount(acceptedJobId), 0)
      assert.deepEqual(service.creditSnapshot(acceptedJobId), {
        quoted: 8, reserved: 8, final: 0, returned: 0,
      })

      const recovered = await client.recoverImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, acceptedJobId)
      assert.equal(recovered.jobId, acceptedJobId)
      assert.equal(service.providerSubmissionCount('image'), 1)
      assert.deepEqual(service.creditSnapshot(acceptedJobId), {
        quoted: 8, reserved: 8, final: 6, returned: 2,
      })
    })

    await suite.test('distinguishes provider-network failure from submission uncertainty', async () => {
      service.reset()
      service.queueScenario('chat', {
        states: ['failed'],
        quotedCredits: 11,
        reservedCredits: 11,
        failureCode: 'CHAT_PROVIDER_NETWORK_UNAVAILABLE',
      })
      service.queueScenario('chat', {
        states: ['failed'],
        quotedCredits: 13,
        reservedCredits: 13,
        failureCode: 'CHAT_PROVIDER_SUBMISSION_UNCERTAIN',
      })

      await assert.rejects(
        client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
          modelId: 'mock-chat-v1',
          system: '',
          userMessage: 'Definitive provider network failure.',
          requestIdentity: 'qualification:chat:network-unavailable',
        }),
        /provider behind this GenStudio KH product failed.*No direct provider or Studio Hub fallback was attempted/i,
      )
      await assert.rejects(
        client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
          modelId: 'mock-chat-v1',
          system: '',
          userMessage: 'Uncertain provider submission.',
          requestIdentity: 'qualification:chat:submission-uncertain',
        }),
        /provider behind this GenStudio KH product failed.*No direct provider or Studio Hub fallback was attempted/i,
      )

      const failedJobs = service.submissions.filter(submission => !submission.replay)
      assert.equal(failedJobs.length, 2)
      assert.equal(service.providerSubmissionCount('chat'), 2)
      assert.deepEqual(service.creditSnapshot(failedJobs[0]!.jobId), {
        quoted: 11, reserved: 11, final: 0, returned: 11,
      })
      assert.deepEqual(service.creditSnapshot(failedJobs[1]!.jobId), {
        quoted: 13, reserved: 13, final: 0, returned: 13,
      })
    })

    await suite.test('rejects expired assets and terminal failed jobs as incomplete', async () => {
      service.reset()
      service.queueScenario('image', {
        states: ['succeeded'],
        quotedCredits: 4,
        reservedCredits: 4,
        finalCredits: 4,
        artifactExpired: true,
      })
      await assert.rejects(
        client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
          prompt: 'The retained image has expired.',
          modelId: 'mock-image-v1',
          aspectRatio: '16:9',
          steps: 4,
          requestIdentity: 'qualification:image:expired',
        }),
        /image download failed \(HTTP 404\)/,
      )

      service.queueScenario('transcription', {
        states: ['succeeded'],
        quotedCredits: 3,
        reservedCredits: 3,
        finalCredits: 3,
        artifactExpired: true,
      })
      await assert.rejects(
        client.transcribeWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
          audioPath,
          modelId: 'mock-whisper-v1',
          requestIdentity: 'qualification:transcription:expired',
        }),
        /SRT download failed \(HTTP 404\)/,
      )

      service.queueScenario('tts', {
        states: ['failed'],
        quotedCredits: 5,
        reservedCredits: 5,
        failureCode: 'VOICE_PROVIDER_RESULT_INVALID',
      })
      await assert.rejects(
        client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, 'failed.mp3'), {
          text: 'A failed job must never produce a completed Story asset.',
          voiceId: 'mock-voice',
          speed: 1,
          requestIdentity: 'qualification:tts:failed',
        }),
        /VOICE_PROVIDER_RESULT_INVALID.*No direct Studio Hub fallback was attempted/,
      )
      const failedTts = service.submissions.find(submission => submission.operation === 'tts')
      assert.ok(failedTts)
      assert.deepEqual(service.creditSnapshot(failedTts.jobId), {
        quoted: 5, reserved: 5, final: 0, returned: 5,
      })
    })

    await suite.test('contains no direct-provider or Studio Hub fallback path', async () => {
      const sources = await Promise.all([
        fs.readFile(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf8'),
        fs.readFile(new URL('../providers/text/genstudio.ts', import.meta.url), 'utf8'),
        fs.readFile(new URL('../providers/image/genstudio.ts', import.meta.url), 'utf8'),
        fs.readFile(new URL('../generators/subtitles.ts', import.meta.url), 'utf8'),
      ])
      const imports = sources.flatMap(importedModules)
      const forbidden = [
        'studiohub-client',
        'openai',
        'anthropic',
        'kie-client',
        'fal-',
        'voicestudio-client',
        'imagestudio-client',
      ]
      for (const moduleName of imports) {
        assert.ok(
          forbidden.every(fragment => !moduleName.toLowerCase().includes(fragment)),
          `GenStudio-only source imports forbidden fallback module ${moduleName}`,
        )
      }
      assert.match(sources[0]!, /No direct provider or Studio Hub fallback was attempted/)
      assert.match(sources[0]!, /No OpenAI, Studio Hub, or direct Voice Studio fallback was attempted/)
      assert.ok(service.requests.every(request => request.authorization.startsWith('Bearer gsk_mock_')))
    })
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.STORY_STUDIO_DISABLE_LISTEN
    delete process.env.STORY_STUDIO_GENSTUDIO_QUALIFICATION
    await service.close()
    await temp.cleanup()
  }
})
