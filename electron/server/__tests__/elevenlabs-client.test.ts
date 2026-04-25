/**
 * Tests for the ElevenLabs direct-API client.
 *
 * Pins the partial-file cleanup invariant: when the TTS stream errors
 * mid-flight, the half-written MP3 at `outPath` must be removed. If it were
 * left behind, the audio generator's `fileExistsWithContent` cache guard
 * (which only rejects zero-byte files) would treat the truncated MP3 as a
 * valid cache hit on the next batch run and silently skip regeneration.
 *
 * HTTP is stubbed via `global.fetch` — no real ElevenLabs call is made.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const realFetch = globalThis.fetch

after(() => {
  globalThis.fetch = realFetch
})

describe('generateTtsToFile — partial file cleanup on mid-stream error', () => {
  test('removes outPath when the response body errors after emitting data', async () => {
    // A Web ReadableStream that enqueues one chunk, yields, then errors —
    // modelling a network drop after some bytes have already been delivered.
    globalThis.fetch = (async () => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(new Uint8Array([0x49, 0x44, 0x33])) // "ID3" bytes
          // Yield so pipeline() can consume the chunk before we surface the error.
          await new Promise(r => setTimeout(r, 10))
          controller.error(new Error('simulated mid-stream network failure'))
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    }) as any

    const { generateTtsToFile } = await import('../lib/elevenlabs-client.js')

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eleven-tts-test-'))
    const outPath = path.join(tmpDir, 'out.mp3')

    try {
      await assert.rejects(
        () => generateTtsToFile('hello world', 'fake-api-key', outPath, { voiceId: 'v123' }),
        /simulated mid-stream network failure/,
      )

      // Core assertion: no partial file left on disk.
      let stillExists = true
      try {
        await fs.stat(outPath)
      } catch {
        stillExists = false
      }
      assert.equal(
        stillExists,
        false,
        'partial MP3 must be deleted after mid-stream error so the cache guard does not skip regeneration',
      )
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
