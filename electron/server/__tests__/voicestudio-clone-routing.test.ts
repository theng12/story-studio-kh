import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, test } from 'node:test'
import { pollJob } from '../lib/voicestudio-client.js'
import {
  buildVoiceStudioParams,
  canRouteVoiceThroughHub,
} from '../providers/audio/voicestudio.js'
import { engineForModelId, modelShipsVoicepack } from '../lib/voicestudio-client.js'

describe('Voice Studio Qwen3 clone routing', () => {
  test('sends a resolved library id to Qwen3 Base and bypasses Hub pooling', () => {
    const params = buildVoiceStudioParams({
      text: 'Hello from Aiden.',
      apiKey: '',
      modelId: 'voicestudio-qwen3-tts-base-0.6b',
      voiceId: 'd47730df601e',
    })

    assert.equal(params.repo, 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit')
    assert.equal(params.voice_library_id, 'd47730df601e')
    assert.equal(canRouteVoiceThroughHub(params), false)
  })

  test('keeps model-global CustomVoice speakers eligible for Hub pooling', () => {
    const params = buildVoiceStudioParams({
      text: 'Hello from the built-in speaker.',
      apiKey: '',
      modelId: 'voicestudio-qwen3-tts',
      voiceId: 'Aiden',
    })

    assert.equal(params.repo, 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit')
    assert.equal(params.preset_speaker, 'Aiden')
    assert.equal(canRouteVoiceThroughHub(params), true)
  })

  test('routes a Hub-owned Qwen clone with its stable worker id', () => {
    const selectedVoice = 'hubvoice:074743daa991'
    const params = buildVoiceStudioParams({
      text: 'Hello from Vincent.',
      apiKey: '',
      modelId: 'voicestudio-qwen3-tts-base-1.7b',
      voiceId: selectedVoice,
    })

    assert.equal(params.voice_library_id, '074743daa991')
    assert.equal(canRouteVoiceThroughHub(params, selectedVoice), true)
  })

  test('uses Voice Studio audited Qwen long-form chunk guidance', () => {
    assert.equal(engineForModelId('voicestudio-qwen3-tts-base-0.6b')?.softMaxChars, 3000)
    assert.equal(engineForModelId('voicestudio-qwen3-tts-base-1.7b')?.softMaxChars, 3000)
  })

  test('classifies Qwen voice mode by exact model rather than shared family', () => {
    assert.equal(modelShipsVoicepack('voicestudio-qwen3-tts'), true)
    assert.equal(modelShipsVoicepack('voicestudio-qwen3-tts-base-0.6b'), false)
    assert.equal(modelShipsVoicepack('voicestudio-qwen3-tts-base-1.7b'), false)
  })

  test('rejects unresolved clone names before they reach a worker', () => {
    assert.throws(
      () => buildVoiceStudioParams({
        text: 'Hello.',
        apiKey: '',
        modelId: 'voicestudio-qwen3-tts-base-1.7b',
        voiceId: 'vsname:Aiden',
      }),
      /not resolved to this Voice Studio server/,
    )
  })

  test('requires a cloned voice for Qwen3 Base', () => {
    assert.throws(
      () => buildVoiceStudioParams({
        text: 'Hello.',
        apiKey: '',
        modelId: 'voicestudio-qwen3-tts-base-1.7b',
      }),
      /needs a saved Voice Studio clone/,
    )
  })

  test('resumes polling after a transient Voice Studio restart', async () => {
    let requests = 0
    const server = http.createServer((req, res) => {
      if (!req.url?.includes('/api/generate/jobs/job-1')) {
        res.writeHead(404).end()
        return
      }
      requests += 1
      if (requests === 1) {
        req.socket.destroy()
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ job: { id: 'job-1', state: 'done' } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const job = await pollJob(`http://127.0.0.1:${address.port}`, 'job-1', {
        timeoutMs: 2_000,
        transportRetryMs: 10,
      })
      assert.equal(job.status, 'done')
      assert.equal(requests, 2)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
