/**
 * A TTS chunk that GenStudio already delivers as MP3 is kept byte for byte; anything else is encoded.
 *
 * Every downloaded chunk was re-encoded to 96 kbps MP3. The Hub sends WAV (that encode is the point),
 * but cloud providers send MP3, and encoding those is a second lossy pass plus CPU for nothing.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
after(() => temp.cleanup())
const { recoverTtsToFile } = await import('../lib/genstudio-client.js')

async function recoverWith(body: Buffer, name: string): Promise<{ out: string; bytes: Buffer }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-copy-'))
  const out = path.join(dir, name)
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input)
    if (url.endsWith('/v1/jobs/tts_copy')) return Response.json({ id: 'tts_copy', state: 'succeeded', audio_url: '/v1/jobs/tts_copy/audio' })
    if (url.endsWith('/v1/jobs/tts_copy/audio')) return new Response(body)
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof globalThis.fetch
  try {
    await recoverTtsToFile('scoped-key', out, 'tts_copy', {} as any)
  } finally {
    globalThis.fetch = original
  }
  return { out, bytes: await fs.readFile(out) }
}

const tone = (codec: string, extra: string[], ext: string) => {
  const file = path.join(os.tmpdir(), `tone-${Math.random().toString(36).slice(2)}.${ext}`)
  assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2:r=44100', '-c:a', codec, ...extra, file]).status, 0)
  return file
}
const codecOf = (file: string) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).stdout.toString().trim()

test('an MP3 artifact is stored unchanged', async () => {
  const mp3 = await fs.readFile(tone('libmp3lame', ['-b:a', '128k'], 'mp3'))
  const { bytes } = await recoverWith(mp3, 'chunk.mp3')
  assert.deepEqual(bytes, mp3)
})

test('a WAV artifact is still encoded to MP3', async () => {
  const wav = await fs.readFile(tone('pcm_s16le', ['-f', 'wav'], 'wav'))
  const { out, bytes } = await recoverWith(wav, 'chunk.mp3')
  assert.notDeepEqual(bytes, wav)
  assert.equal(codecOf(out), 'mp3')
})

test('no scratch file is left beside the output', async () => {
  const mp3 = await fs.readFile(tone('libmp3lame', [], 'mp3'))
  const { out } = await recoverWith(mp3, 'chunk.mp3')
  assert.deepEqual(await fs.readdir(path.dirname(out)), ['chunk.mp3'])
})
