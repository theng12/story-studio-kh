import assert from 'node:assert/strict'
import fs from 'fs/promises'
import http from 'node:http'
import os from 'os'
import path from 'path'
import { describe, test } from 'node:test'
import { pollJob } from '../lib/voicestudio-client.js'
import {
  buildVoiceStudioParams,
  canRouteVoiceThroughHub,
  downloadHubArtifactToFile,
  VOICESTUDIO_HUB_TTS_TIMEOUT_MS,
} from '../providers/audio/voicestudio.js'
import { engineForModelId, modelShipsVoicepack } from '../lib/voicestudio-client.js'
import { GenerateAudioSchema } from '../contracts/index.js'

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

  test('downloads completed audio through the authenticated Hub gateway', async () => {
    let requestedPath = ''
    let token = ''
    const server = http.createServer((req, res) => {
      requestedPath = req.url || ''
      token = String(req.headers['x-hub-token'] || '')
      res.setHeader('Content-Type', 'audio/wav')
      res.end(Buffer.from('test-audio'))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const outPath = path.join(os.tmpdir(), `story-studio-hub-audio-${Date.now()}.wav`)
    try {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      await downloadHubArtifactToFile(
        `http://127.0.0.1:${address.port}`,
        'fleet-access',
        'batch 123',
        0,
        outPath,
      )
      assert.equal(requestedPath, '/api/hub/jobs/batch%20123/items/0/artifact')
      assert.equal(token, 'fleet-access')
      assert.equal(await fs.readFile(outPath, 'utf8'), 'test-audio')
    } finally {
      await fs.rm(outPath, { force: true })
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  test('uses Voice Studio internal chunking for chapter-scale clone dispatches', () => {
    assert.equal(engineForModelId('voicestudio-qwen3-tts-base-0.6b')?.softMaxChars, 15000)
    assert.equal(engineForModelId('voicestudio-qwen3-tts-base-1.7b')?.softMaxChars, 15000)
    assert.equal(engineForModelId('voicestudio-chatterbox-mlx')?.softMaxChars, 15000)
    assert.equal(engineForModelId('voicestudio-voxcpm-mlx')?.softMaxChars, 15000)
    assert.equal(engineForModelId('voicestudio-qwen3-tts')?.softMaxChars, 3000)
    assert.equal(VOICESTUDIO_HUB_TTS_TIMEOUT_MS, 2 * 60 * 60_000)
  })

  test('discards retired per-job chunk overrides at the request boundary', () => {
    const base = { episode_id: 'EP0001', model: 'voicestudio-qwen3-tts-base-0.6b' }
    for (const max_chunk_chars of [50, 15000, 15001]) {
      const parsed = GenerateAudioSchema.safeParse({ ...base, max_chunk_chars })
      assert.equal(parsed.success, true, 'legacy clients remain compatible')
      if (parsed.success) assert.equal('max_chunk_chars' in parsed.data, false)
    }
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
