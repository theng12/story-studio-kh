/**
 * "Smaller files": the optional `output_format` request field on music, image and narration jobs.
 *
 * Two promises are pinned here, because both are about money:
 *  - ABSENT means today's request exactly. The three idempotency keys (and the body) must be
 *    byte-identical to what they were before the field existed, or an in-flight job would stop
 *    replaying and be bought a second time.
 *  - PRESENT must move the key, or flipping the toggle for an identical prompt would silently
 *    replay the old-format job.
 *
 * Runs against the in-process mock GenStudio service: zero network, zero spend.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
const client = await import('../lib/genstudio-client.js')

const sha44 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 44)

void test('keys: absent is byte-identical to the pre-field digest, present moves the key', () => {
  const music = { title: 'Adagio', prompt: 'strings', instrumental: true, modelId: 'm' }
  assert.equal(
    client.buildGenStudioMusicIdempotencyKey(music),
    `story-music-${sha44({ title: 'Adagio', prompt: 'strings', lyrics: null, instrumental: true, model_id: 'm', request_identity: null })}`,
  )
  assert.notEqual(client.buildGenStudioMusicIdempotencyKey(music),
    client.buildGenStudioMusicIdempotencyKey({ ...music, outputFormat: 'm4a' }))

  const image = { prompt: 'a temple', modelId: 'm', aspectRatio: '16:9', width: 1280, height: 720, seed: 3, requestIdentity: 'scene:1' }
  assert.equal(
    client.buildGenStudioImageIdempotencyKey(image),
    `story-image-${sha44({
      prompt: 'a temple', model_id: 'm', aspect_ratio: '16:9', steps: 4, width: 1280, height: 720, seed: 3,
      request_identity: 'scene:1', reference_asset_ids: [],
    })}`,
  )
  assert.notEqual(client.buildGenStudioImageIdempotencyKey(image),
    client.buildGenStudioImageIdempotencyKey({ ...image, outputFormat: 'jpeg' }))

  const tts = { text: 'Hello there.', voiceId: 'v', modelId: 'm', speed: 1, maxInputCharacters: 1000, requestIdentity: 'chunk:1' }
  const plain = client.buildGenStudioSubmission(tts)
  assert.equal(plain.idempotencyKey, `story-tts-${createHash('sha256').update(JSON.stringify({
    model_id: 'm', voice_id: 'v', text: 'Hello there.', speed: 1, request_identity: 'chunk:1',
  })).digest('hex').slice(0, 48)}`)
  assert.equal('output_format' in plain.body, false)
  const compressed = client.buildGenStudioSubmission({ ...tts, outputFormat: 'm4a' })
  assert.equal(compressed.body.output_format, 'm4a')
  assert.notEqual(compressed.idempotencyKey, plain.idempotencyKey)
})

const postedBody = (service: { requests: Array<{ method: string; path: string; bodyText: string }> }, route: string) => {
  const posts = service.requests.filter(r => r.method === 'POST' && r.path === route)
  assert.ok(posts.length > 0, `no POST ${route}`)
  return JSON.parse(posts[posts.length - 1]!.bodyText) as Record<string, unknown>
}

void test('the wire body carries output_format only when it was asked for', async (suite) => {
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    await settings.setGenStudioUrl(service.baseUrl)

    await suite.test('music', async () => {
      service.reset()
      await client.generateMusicWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        title: 'A', prompt: 'p', instrumental: true, modelId: 'mock-music-v1', requestIdentity: 'm:plain',
      })
      assert.equal('output_format' in postedBody(service, '/v1/music/generations'), false)
      await client.generateMusicWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        title: 'A', prompt: 'p', instrumental: true, modelId: 'mock-music-v1', requestIdentity: 'm:plain', outputFormat: 'm4a',
      })
      assert.equal(postedBody(service, '/v1/music/generations').output_format, 'm4a')
      assert.equal(service.providerSubmissionCount('music'), 2,
        'toggling the format for an identical request is a new job, not a replay of the old one')
    })

    await suite.test('image', async () => {
      service.reset()
      const base = { prompt: 'A calm moonlit temple above a river.', modelId: 'mock-image-v1', aspectRatio: '16:9', requestIdentity: 'scene:fmt' }
      await client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, base)
      assert.equal('output_format' in postedBody(service, '/v1/images/generations'), false)
      await client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, { ...base, outputFormat: 'jpeg' })
      assert.equal(postedBody(service, '/v1/images/generations').output_format, 'jpeg')
      assert.equal(service.providerSubmissionCount('image'), 2)
    })

    await suite.test('narration: AAC transport still ends as the MP3 chapter, and so does an old node that sent WAV', async () => {
      service.reset()
      const aac = path.join(temp.dir, 'transport.m4a')
      const make = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-ac', '1', '-c:a', 'aac', '-b:a', '128k', '-f', 'ipod', aac])
      assert.equal(make.status, 0)
      const aacBytes = await fs.readFile(aac)
      const request = (identity: string, extra: Record<string, unknown> = {}) => ({
        text: 'This speech exists only inside the deterministic mock service.',
        voiceId: 'mock-voice', modelId: 'mock-tts-model', maxInputCharacters: 12_000, speed: 1,
        requestIdentity: identity, ...extra,
      })
      const codec = (file: string) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).stdout.toString().trim()
      const duration = (file: string) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString())

      // The lane honoured the request: an m4a body arrives.
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (input: any, init?: any) => {
        if (/\/v1\/jobs\/[^/]+\/audio$/.test(String(input))) {
          return new Response(aacBytes, { status: 200, headers: { 'Content-Type': 'audio/mp4' } })
        }
        return realFetch(input, init)
      }) as typeof fetch
      const fromAac = path.join(temp.dir, 'from-aac.mp3')
      try {
        await client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, fromAac, request('tts:aac', { outputFormat: 'm4a' }) as any)
      } finally {
        globalThis.fetch = realFetch
      }
      assert.equal(postedBody(service, '/v1/audio/jobs').output_format, 'm4a')
      assert.equal(codec(fromAac), 'mp3', 'the chapter is written as MP3 whatever the transport was')
      assert.ok(Math.abs(duration(fromAac) - 2) < 0.15, `duration ${duration(fromAac)}`)

      // An old node ignored the field and sent the WAV the mock always serves: same chapter format.
      const fromWav = path.join(temp.dir, 'from-wav.mp3')
      await client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, fromWav, request('tts:wav', { outputFormat: 'm4a' }) as any)
      assert.equal(codec(fromWav), 'mp3')

      // And with the toggle off nothing about the request changed.
      await client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, 'plain.mp3'), request('tts:plain') as any)
      assert.equal('output_format' in postedBody(service, '/v1/audio/jobs'), false)
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})
